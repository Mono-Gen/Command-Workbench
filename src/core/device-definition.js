const { parseCommand } = require('./parse-command');

const MAX_FILE_BYTES = 1048576;
const MAX_DEPTH = 16;
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const validatedDefinitions = new WeakSet();
const ERROR_ORDER_POINTER = Symbol('errorOrderPointer');

function escapePointerToken(value) {
  return String(value).replaceAll('~', '~0').replaceAll('/', '~1');
}

function childPointer(pointer, key) {
  return `${pointer}/${escapePointerToken(key)}`;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function scanStructure(root) {
  const stack = [{ value: root, pointer: '', depth: 1 }];
  const reservedErrors = [];
  const structuralErrors = [];
  const structurallyInvalidPointers = new Set();

  while (stack.length > 0) {
    const current = stack.pop();
    const { value, pointer, depth } = current;
    if (typeof value === 'number' && !Number.isFinite(value)) {
      structuralErrors.push({ pointer, code: 'invalid_type' });
      structurallyInvalidPointers.add(pointer);
      continue;
    }
    if (value === null || typeof value !== 'object') {
      continue;
    }
    if (depth > MAX_DEPTH) {
      return { tooDeep: true, reservedErrors: [], structuralErrors: [] };
    }
    if (!Array.isArray(value) && !isPlainObject(value)) {
      structuralErrors.push({ pointer, code: 'invalid_type' });
      structurallyInvalidPointers.add(pointer);
      continue;
    }

    const keys = Object.keys(value);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      const nextPointer = childPointer(pointer, key);
      if (RESERVED_KEYS.has(key)) {
        reservedErrors.push({ pointer: nextPointer, code: 'reserved_key' });
        continue;
      }
      stack.push({ value: value[key], pointer: nextPointer, depth: depth + 1 });
    }
  }

  return { tooDeep: false, reservedErrors, structuralErrors, structurallyInvalidPointers };
}

function unknownFields(value, allowed, pointer, errors) {
  for (const key of Object.keys(value)) {
    if (RESERVED_KEYS.has(key)) {
      continue;
    }
    if (!allowed.has(key)) {
      const error = { pointer, code: 'unknown_field' };
      Object.defineProperty(error, ERROR_ORDER_POINTER, {
        value: childPointer(pointer, key),
        enumerable: false,
      });
      errors.push(error);
    }
  }
}

function sortErrorsInDocumentOrder(root, errors) {
  const ranks = new Map();
  const stack = [{ value: root, pointer: '', traverse: true }];
  let rank = 0;
  while (stack.length > 0) {
    const { value, pointer, traverse } = stack.pop();
    ranks.set(pointer, rank);
    rank += 1;
    if (!traverse || value === null || typeof value !== 'object') {
      continue;
    }
    const keys = Object.keys(value);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      stack.push({
        value: value[key],
        pointer: childPointer(pointer, key),
        traverse: !RESERVED_KEYS.has(key),
      });
    }
  }
  return errors
    .map((error, index) => ({ error, index }))
    .sort((left, right) => {
      const leftPointer = left.error[ERROR_ORDER_POINTER] ?? left.error.pointer;
      const rightPointer = right.error[ERROR_ORDER_POINTER] ?? right.error.pointer;
      const leftRank = ranks.get(leftPointer) ?? Number.POSITIVE_INFINITY;
      const rightRank = ranks.get(rightPointer) ?? Number.POSITIVE_INFINITY;
      return leftRank - rightRank || left.index - right.index;
    })
    .map(({ error }) => error);
}

function required(value, key, pointer, errors) {
  if (!Object.hasOwn(value, key)) {
    errors.push({ pointer: childPointer(pointer, key), code: 'missing_field' });
    return false;
  }
  return true;
}

function validateString(value, pointer, errors, { min = 0, max, nonWhitespace = false } = {}) {
  if (typeof value !== 'string') {
    errors.push({ pointer, code: 'invalid_type' });
    return false;
  }
  if (value.length < min || value.length > max || (nonWhitespace && value.trim().length === 0)) {
    errors.push({ pointer, code: 'invalid_value' });
    return false;
  }
  return true;
}

function validateInteger(value, pointer, errors, min, max) {
  if (typeof value !== 'number') {
    errors.push({ pointer, code: 'invalid_type' });
    return false;
  }
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    errors.push({ pointer, code: 'invalid_value' });
    return false;
  }
  return true;
}

function compileTemplatePart(text, pointer, context, errors, tokens) {
  if (typeof text !== 'string') {
    errors.push({ pointer, code: 'invalid_type' });
    return;
  }
  if (text.length > 1024) {
    errors.push({ pointer, code: 'invalid_value' });
    return;
  }

  let staticText = '';
  function flushStatic() {
    if (staticText.length === 0) {
      return;
    }
    const parsed = parseCommand(staticText, { mode: 'text', appendTerminator: 'none' });
    if (!parsed.ok) {
      errors.push({ pointer, code: 'invalid_notation', detail: { errors: parsed.errors } });
    } else {
      tokens.push({ type: 'static', bytes: Array.from(parsed.bytes) });
    }
    staticText = '';
  }

  let index = 0;
  while (index < text.length) {
    if (text.startsWith('{{', index)) {
      staticText += '{';
      index += 2;
      continue;
    }
    if (text.startsWith('}}', index)) {
      staticText += '}';
      index += 2;
      continue;
    }
    if (text[index] === '{') {
      const match = /^\{(var|capture)\.([a-z][a-z0-9_]{0,31})\}/.exec(text.slice(index));
      if (match === null) {
        errors.push({ pointer, code: 'invalid_template', detail: { index } });
        index += 1;
        continue;
      }
      flushStatic();
      const [, source, name] = match;
      const exists = source === 'var'
        ? context.variables.has(name)
        : context.allowCaptures && context.captures.has(name);
      if (!exists) {
        errors.push({ pointer, code: 'unknown_reference', detail: { source, name } });
      } else {
        tokens.push({ type: 'reference', source, name });
      }
      index += match[0].length;
      continue;
    }
    if (text[index] === '}') {
      errors.push({ pointer, code: 'invalid_template', detail: { index } });
      index += 1;
      continue;
    }
    staticText += text[index];
    index += 1;
  }
  flushStatic();
}

function compileTemplate(value, pointer, context, errors, { nullable = false } = {}) {
  if (value === null && nullable) {
    return null;
  }
  const tokens = [];
  if (typeof value === 'string') {
    compileTemplatePart(value, pointer, context, errors, tokens);
  } else if (Array.isArray(value)) {
    if (value.length < 1 || value.length > 32) {
      errors.push({ pointer, code: 'invalid_value' });
      return null;
    }
    value.forEach((part, index) => {
      compileTemplatePart(part, childPointer(pointer, index), context, errors, tokens);
    });
  } else {
    errors.push({ pointer, code: 'invalid_type' });
    return null;
  }
  return tokens;
}

function compilePattern(pattern, pointer, errors) {
  if (typeof pattern !== 'string') {
    errors.push({ pointer, code: 'invalid_type' });
    return null;
  }
  if (pattern.length === 0) {
    errors.push({ pointer, code: 'invalid_pattern', detail: { index: 0, reason: 'empty' } });
    return null;
  }
  if (pattern.length > 256) {
    errors.push({ pointer, code: 'invalid_value' });
    return null;
  }

  const elements = [];
  const captures = new Set();
  let stars = 0;
  let literal = '';
  function flushLiteral() {
    if (literal.length > 0) {
      elements.push({ type: 'literal', text: literal });
      literal = '';
    }
  }
  function fail(index, reason) {
    errors.push({ pointer, code: 'invalid_pattern', detail: { index, reason } });
    return null;
  }

  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index];
    if ((char === '{' || char === '}' || char === '*') && pattern[index + 1] === char) {
      literal += char;
      index += 2;
      continue;
    }
    if (char === '{') {
      const match = /^\{([a-z][a-z0-9_]{0,31})\}/.exec(pattern.slice(index));
      if (match === null) {
        return fail(index, 'syntax');
      }
      flushLiteral();
      if (elements.length > 0 && elements.at(-1).type !== 'literal') {
        return fail(index, 'adjacent');
      }
      const name = match[1];
      if (captures.has(name)) {
        return fail(index, 'duplicate_capture');
      }
      if (captures.size === 4) {
        return fail(index, 'too_many_captures');
      }
      captures.add(name);
      elements.push({ type: 'capture', name });
      index += match[0].length;
      continue;
    }
    if (char === '}') {
      return fail(index, 'syntax');
    }
    if (char === '*') {
      flushLiteral();
      if (stars === 1) {
        return fail(index, 'multiple_star');
      }
      if (elements.length > 0 && elements.at(-1).type !== 'literal') {
        return fail(index, 'adjacent');
      }
      stars += 1;
      elements.push({ type: 'star' });
      index += 1;
      continue;
    }
    literal += char;
    index += 1;
  }
  flushLiteral();
  return { elements, captures };
}

function validateVariableValue(value, variable, pointer, errors, mismatchCode = 'type_mismatch') {
  if (variable.type === 'enum') {
    if (typeof value !== 'string') {
      errors.push({ pointer, code: mismatchCode });
      return false;
    }
    if (!variable.values.includes(value)) {
      errors.push({ pointer, code: 'out_of_range' });
      return false;
    }
    return true;
  }
  if (variable.type === 'int') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      errors.push({ pointer, code: mismatchCode });
      return false;
    }
    if (value < variable.min || value > variable.max) {
      errors.push({ pointer, code: 'out_of_range' });
      return false;
    }
    return true;
  }
  if (variable.type === 'bool') {
    if (typeof value !== 'boolean') {
      errors.push({ pointer, code: mismatchCode });
      return false;
    }
    return true;
  }
  if (variable.type === 'string') {
    if (typeof value !== 'string') {
      errors.push({ pointer, code: mismatchCode });
      return false;
    }
    if (value.length > variable.maxLength) {
      errors.push({ pointer, code: 'out_of_range' });
      return false;
    }
    return true;
  }
  return false;
}

function validateVariables(value, pointer, errors) {
  const variables = {};
  if (!isPlainObject(value)) {
    errors.push({ pointer, code: 'not_an_object' });
    return variables;
  }
  const names = Object.keys(value).filter((key) => !RESERVED_KEYS.has(key));
  if (names.length > 64) {
    errors.push({ pointer, code: 'too_many' });
  }

  for (const name of names) {
    const variablePointer = childPointer(pointer, name);
    if (!NAME_PATTERN.test(name)) {
      errors.push({ pointer: variablePointer, code: 'invalid_name' });
    }
    const source = value[name];
    if (!isPlainObject(source)) {
      errors.push({ pointer: variablePointer, code: 'not_an_object' });
      continue;
    }
    const hasInitial = required(source, 'initial', variablePointer, errors);
    const typePointer = childPointer(variablePointer, 'type');
    if (!required(source, 'type', variablePointer, errors)) {
      unknownFields(source, new Set(['type', 'initial']), variablePointer, errors);
      continue;
    }
    if (typeof source.type !== 'string') {
      errors.push({ pointer: typePointer, code: 'invalid_type' });
      unknownFields(source, new Set(['type', 'initial']), variablePointer, errors);
      continue;
    }

    let normalized;
    if (source.type === 'enum') {
      unknownFields(source, new Set(['type', 'values', 'initial']), variablePointer, errors);
      normalized = { type: 'enum', values: [] };
      if (required(source, 'values', variablePointer, errors)) {
        if (!Array.isArray(source.values)) {
          errors.push({ pointer: childPointer(variablePointer, 'values'), code: 'not_an_array' });
        } else {
          const validValues = source.values.length >= 1 && source.values.length <= 64
            && source.values.every((item) => typeof item === 'string' && item.length >= 1 && item.length <= 32)
            && new Set(source.values).size === source.values.length;
          if (!validValues) {
            errors.push({ pointer: childPointer(variablePointer, 'values'), code: 'invalid_value' });
          }
          normalized.values = source.values.filter((item) => typeof item === 'string');
        }
      }
    } else if (source.type === 'int') {
      unknownFields(source, new Set(['type', 'min', 'max', 'initial']), variablePointer, errors);
      normalized = {
        type: 'int',
        min: source.min ?? -2147483648,
        max: source.max ?? 2147483647,
      };
      let boundsValid = true;
      for (const key of ['min', 'max']) {
        if (Object.hasOwn(source, key) && !Number.isSafeInteger(source[key])) {
          const code = typeof source[key] === 'number' ? 'invalid_value' : 'invalid_type';
          errors.push({ pointer: childPointer(variablePointer, key), code });
          boundsValid = false;
        }
      }
      if (boundsValid && normalized.min > normalized.max) {
        errors.push({ pointer: childPointer(variablePointer, 'min'), code: 'invalid_value' });
        boundsValid = false;
      }
      normalized.boundsValid = boundsValid;
    } else if (source.type === 'bool') {
      unknownFields(source, new Set(['type', 'initial']), variablePointer, errors);
      normalized = { type: 'bool' };
    } else if (source.type === 'string') {
      unknownFields(source, new Set(['type', 'maxLength', 'initial']), variablePointer, errors);
      normalized = { type: 'string', maxLength: source.maxLength ?? 64 };
      if (Object.hasOwn(source, 'maxLength')) {
        validateInteger(source.maxLength, childPointer(variablePointer, 'maxLength'), errors, 0, 64);
      }
    } else {
      errors.push({ pointer: typePointer, code: 'invalid_value' });
      unknownFields(source, new Set(['type', 'initial']), variablePointer, errors);
      continue;
    }

    if (!hasInitial) {
      continue;
    }
    if (normalized.type !== 'int' || normalized.boundsValid) {
      validateVariableValue(source.initial, normalized, childPointer(variablePointer, 'initial'), errors);
    } else if (typeof source.initial !== 'number' || !Number.isSafeInteger(source.initial)) {
      errors.push({ pointer: childPointer(variablePointer, 'initial'), code: 'type_mismatch' });
    } else {
      errors.push({ pointer: childPointer(variablePointer, 'initial'), code: 'out_of_range' });
    }
    delete normalized.boundsValid;
    normalized.initial = source.initial;
    variables[name] = normalized;
  }
  return variables;
}

function validateCondition(condition, pointer, variables, errors) {
  if (!isPlainObject(condition)) {
    errors.push({ pointer, code: 'invalid_condition' });
    return null;
  }
  const variable = typeof condition.var === 'string' && Object.hasOwn(variables, condition.var)
    ? variables[condition.var]
    : undefined;
  const equalityKeys = ['is', 'isNot', 'in'].filter((key) => Object.hasOwn(condition, key));
  const hasRange = Object.hasOwn(condition, 'min') || Object.hasOwn(condition, 'max');
  const shapeCount = equalityKeys.length + (hasRange ? 1 : 0);
  const allowed = new Set(['var', 'is', 'isNot', 'in', 'min', 'max']);
  unknownFields(condition, allowed, pointer, errors);
  if (!Object.hasOwn(condition, 'var')
    || Object.keys(condition).some((key) => !allowed.has(key))
    || shapeCount !== 1) {
    errors.push({ pointer, code: 'invalid_condition' });
    return null;
  }
  if (variable === undefined) {
    errors.push({ pointer: childPointer(pointer, 'var'), code: 'unknown_reference' });
    return null;
  }

  if (equalityKeys.length === 1) {
    const key = equalityKeys[0];
    if (key === 'in') {
      if (!Array.isArray(condition.in) || condition.in.length < 1 || condition.in.length > 16) {
        errors.push({ pointer: childPointer(pointer, 'in'), code: 'invalid_condition' });
      } else {
        condition.in.forEach((item, index) => {
          validateVariableValue(item, variable, childPointer(childPointer(pointer, 'in'), index), errors);
        });
      }
    } else {
      validateVariableValue(condition[key], variable, childPointer(pointer, key), errors);
    }
  } else {
    if (variable.type !== 'int') {
      errors.push({ pointer, code: 'invalid_condition' });
      return null;
    }
    for (const key of ['min', 'max']) {
      if (Object.hasOwn(condition, key)) {
        validateVariableValue(condition[key], variable, childPointer(pointer, key), errors);
      }
    }
    if (Object.hasOwn(condition, 'min') && Object.hasOwn(condition, 'max')
      && Number.isSafeInteger(condition.min) && Number.isSafeInteger(condition.max)
      && condition.min > condition.max) {
      errors.push({ pointer, code: 'invalid_condition' });
    }
  }
  return {
    ...condition,
    ...(Array.isArray(condition.in) ? { in: [...condition.in] } : {}),
  };
}

function validateCaptureConfig(value, pointer, patternCaptures, errors) {
  const captures = {};
  if (!isPlainObject(value)) {
    errors.push({ pointer, code: 'not_an_object' });
    return captures;
  }
  for (const name of Object.keys(value).filter((key) => !RESERVED_KEYS.has(key))) {
    const capturePointer = childPointer(pointer, name);
    if (!patternCaptures.has(name)) {
      errors.push({ pointer: capturePointer, code: 'unknown_reference' });
    }
    const source = value[name];
    if (!isPlainObject(source)) {
      errors.push({ pointer: capturePointer, code: 'not_an_object' });
      continue;
    }
    unknownFields(source, new Set(['map']), capturePointer, errors);
    const normalized = {};
    if (Object.hasOwn(source, 'map')) {
      const mapPointer = childPointer(capturePointer, 'map');
      if (!isPlainObject(source.map)) {
        errors.push({ pointer: mapPointer, code: 'not_an_object' });
      } else {
        const entries = Object.entries(source.map).filter(([key]) => !RESERVED_KEYS.has(key));
        const valid = entries.length >= 1 && entries.length <= 64
          && entries.every(([key, item]) => key.length > 0
            && (typeof item === 'string' || typeof item === 'boolean'
              || (typeof item === 'number' && Number.isFinite(item))));
        if (!valid) {
          errors.push({ pointer: mapPointer, code: 'invalid_value' });
        }
        normalized.map = Object.fromEntries(entries);
      }
    }
    captures[name] = normalized;
  }
  return captures;
}

function validateHandler(value, pointer, templateContext, errors) {
  if (!isPlainObject(value)) {
    errors.push({ pointer, code: 'not_an_object' });
    return { present: true, reply: null };
  }
  unknownFields(value, new Set(['reply']), pointer, errors);
  return {
    present: true,
    reply: Object.hasOwn(value, 'reply')
      ? compileTemplate(value.reply, childPointer(pointer, 'reply'), templateContext, errors, { nullable: true })
      : null,
  };
}

function validateCommands(value, pointer, variables, errors) {
  if (!Array.isArray(value)) {
    errors.push({ pointer, code: 'not_an_array' });
    return [];
  }
  if (value.length > 500) {
    // Stop here: validating every element of a huge array would only exhaust memory.
    errors.push({ pointer, code: 'too_many' });
    return [];
  }
  const commands = [];
  const ids = new Set();

  value.forEach((source, index) => {
    const commandPointer = childPointer(pointer, index);
    if (!isPlainObject(source)) {
      errors.push({ pointer: commandPointer, code: 'not_an_object' });
      return;
    }
    unknownFields(source, new Set([
      'id', 'pattern', 'caseInsensitive', 'capture', 'when', 'do', 'reply', 'delayMs',
      'otherwise', 'invalid',
    ]), commandPointer, errors);

    let id;
    if (Object.hasOwn(source, 'id')) {
      if (validateString(source.id, childPointer(commandPointer, 'id'), errors, { min: 1, max: 64 })) {
        id = source.id;
        if (ids.has(id)) {
          errors.push({ pointer: childPointer(commandPointer, 'id'), code: 'duplicate_name' });
        }
        ids.add(id);
      }
    }

    let compiledPattern = null;
    if (required(source, 'pattern', commandPointer, errors)) {
      compiledPattern = compilePattern(source.pattern, childPointer(commandPointer, 'pattern'), errors);
    }
    const patternCaptures = compiledPattern?.captures ?? new Set();
    let caseInsensitive = false;
    if (Object.hasOwn(source, 'caseInsensitive')) {
      if (typeof source.caseInsensitive !== 'boolean') {
        errors.push({ pointer: childPointer(commandPointer, 'caseInsensitive'), code: 'invalid_type' });
      } else {
        caseInsensitive = source.caseInsensitive;
      }
    }
    const captures = Object.hasOwn(source, 'capture')
      ? validateCaptureConfig(source.capture, childPointer(commandPointer, 'capture'), patternCaptures, errors)
      : {};
    const templateContext = {
      variables: new Set(Object.keys(variables)),
      captures: patternCaptures,
      allowCaptures: true,
    };

    const when = [];
    if (Object.hasOwn(source, 'when')) {
      const whenPointer = childPointer(commandPointer, 'when');
      if (!Array.isArray(source.when)) {
        errors.push({ pointer: whenPointer, code: 'not_an_array' });
      } else if (source.when.length > 8) {
        errors.push({ pointer: whenPointer, code: 'too_many' });
      } else {
        source.when.forEach((condition, conditionIndex) => {
          const normalized = validateCondition(
            condition,
            childPointer(whenPointer, conditionIndex),
            variables,
            errors,
          );
          if (normalized !== null) {
            when.push(normalized);
          }
        });
      }
    }

    const set = {};
    if (Object.hasOwn(source, 'do')) {
      const doPointer = childPointer(commandPointer, 'do');
      if (!isPlainObject(source.do)) {
        errors.push({ pointer: doPointer, code: 'not_an_object' });
      } else {
        unknownFields(source.do, new Set(['set']), doPointer, errors);
        if (Object.hasOwn(source.do, 'set')) {
          const setPointer = childPointer(doPointer, 'set');
          if (!isPlainObject(source.do.set)) {
            errors.push({ pointer: setPointer, code: 'not_an_object' });
          } else {
            const entries = Object.entries(source.do.set).filter(([key]) => !RESERVED_KEYS.has(key));
            if (entries.length > 16) {
              errors.push({ pointer: setPointer, code: 'too_many' });
            }
            for (const [name, setValue] of entries) {
              const setValuePointer = childPointer(setPointer, name);
              const variable = Object.hasOwn(variables, name) ? variables[name] : undefined;
              if (variable === undefined) {
                errors.push({ pointer: setValuePointer, code: 'unknown_reference' });
                continue;
              }
              const captureMatch = typeof setValue === 'string'
                ? /^\{capture\.([a-z][a-z0-9_]{0,31})\}$/.exec(setValue)
                : null;
              if (captureMatch !== null) {
                if (!patternCaptures.has(captureMatch[1])) {
                  errors.push({ pointer: setValuePointer, code: 'unknown_reference' });
                } else {
                  set[name] = { source: 'capture', name: captureMatch[1] };
                }
              } else if (validateVariableValue(setValue, variable, setValuePointer, errors)) {
                set[name] = { source: 'literal', value: setValue };
              }
            }
          }
        }
      }
    }

    let delayMs = 0;
    if (Object.hasOwn(source, 'delayMs')) {
      if (validateInteger(source.delayMs, childPointer(commandPointer, 'delayMs'), errors, 0, 60000)) {
        delayMs = source.delayMs;
      }
    }
    const reply = Object.hasOwn(source, 'reply')
      ? compileTemplate(source.reply, childPointer(commandPointer, 'reply'), templateContext, errors, { nullable: true })
      : null;
    const otherwise = Object.hasOwn(source, 'otherwise')
      ? validateHandler(source.otherwise, childPointer(commandPointer, 'otherwise'), templateContext, errors)
      : { present: false, reply: null };
    const invalid = Object.hasOwn(source, 'invalid')
      ? validateHandler(source.invalid, childPointer(commandPointer, 'invalid'), templateContext, errors)
      : { present: false, reply: null };

    commands.push({
      id,
      sourcePattern: source.pattern,
      pattern: compiledPattern?.elements ?? [],
      captureNames: Array.from(patternCaptures),
      caseInsensitive,
      captures,
      when,
      set,
      reply,
      delayMs,
      otherwise,
      invalid,
    });
  });
  return commands;
}

function validateNotifications(value, pointer, variables, errors) {
  if (!Array.isArray(value)) {
    errors.push({ pointer, code: 'not_an_array' });
    return [];
  }
  if (value.length > 100) {
    errors.push({ pointer, code: 'too_many' });
    return [];
  }
  const notifications = [];
  const context = {
    variables: new Set(Object.keys(variables)), captures: new Set(), allowCaptures: false,
  };
  value.forEach((source, index) => {
    const notificationPointer = childPointer(pointer, index);
    if (!isPlainObject(source)) {
      errors.push({ pointer: notificationPointer, code: 'not_an_object' });
      return;
    }
    unknownFields(source, new Set(['when', 'send', 'to']), notificationPointer, errors);
    let variableName;
    if (!Object.hasOwn(source, 'when') || !isPlainObject(source.when)
      || Object.keys(source.when).length !== 2
      || !Object.hasOwn(source.when, 'var') || !Object.hasOwn(source.when, 'changes')
      || source.when.changes !== true) {
      errors.push({ pointer: childPointer(notificationPointer, 'when'), code: 'invalid_condition' });
    } else if (typeof source.when.var !== 'string'
      || !Object.hasOwn(variables, source.when.var)) {
      errors.push({ pointer: childPointer(childPointer(notificationPointer, 'when'), 'var'), code: 'unknown_reference' });
    } else {
      variableName = source.when.var;
    }
    if (isPlainObject(source.when)) {
      unknownFields(source.when, new Set(['var', 'changes']), childPointer(notificationPointer, 'when'), errors);
    }
    let send = null;
    if (!required(source, 'send', notificationPointer, errors)) {
      send = null;
    } else {
      send = compileTemplate(source.send, childPointer(notificationPointer, 'send'), context, errors);
    }
    let to = 'all';
    if (Object.hasOwn(source, 'to')) {
      if (typeof source.to !== 'string') {
        errors.push({ pointer: childPointer(notificationPointer, 'to'), code: 'invalid_type' });
      } else if (source.to !== 'all' && source.to !== 'sender') {
        errors.push({ pointer: childPointer(notificationPointer, 'to'), code: 'invalid_value' });
      } else {
        to = source.to;
      }
    }
    notifications.push({ variable: variableName, send, to });
  });
  return notifications;
}

function deepFreeze(root) {
  const stack = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
      continue;
    }
    for (const child of Object.values(value)) {
      if (child !== null && typeof child === 'object') {
        stack.push(child);
      }
    }
    Object.freeze(value);
  }
  return root;
}

function validateDefinition(value) {
  const scan = scanStructure(value);
  if (scan.tooDeep) {
    return { ok: false, errors: [{ pointer: '', code: 'too_deep' }] };
  }
  if (scan.structurallyInvalidPointers?.has('')) {
    return {
      ok: false,
      errors: sortErrorsInDocumentOrder(value, [...scan.reservedErrors, ...scan.structuralErrors]),
    };
  }
  if (!isPlainObject(value)) {
    return { ok: false, errors: [{ pointer: '', code: 'not_an_object' }] };
  }

  let errors = [...scan.reservedErrors, ...scan.structuralErrors];
  unknownFields(value, new Set([
    'schemaVersion', 'transport', 'name', 'description', 'framing', 'greeting', 'connection',
    'variables', 'commands', 'notifications', 'unknown',
  ]), '', errors);

  if (!Object.hasOwn(value, 'schemaVersion') || !Number.isSafeInteger(value.schemaVersion)) {
    errors.push({ pointer: '/schemaVersion', code: 'invalid_schema_version' });
  } else if (value.schemaVersion !== 1) {
    errors.push({ pointer: '/schemaVersion', code: 'unsupported_schema_version' });
  }
  let transport = 'tcp';
  if (Object.hasOwn(value, 'transport')) {
    if (typeof value.transport !== 'string') {
      errors.push({ pointer: '/transport', code: 'invalid_type' });
    } else if (!['tcp', 'udp'].includes(value.transport)) {
      errors.push({ pointer: '/transport', code: 'invalid_value' });
    } else {
      transport = value.transport;
    }
  }
  if (required(value, 'name', '', errors)) {
    validateString(value.name, '/name', errors, { min: 1, max: 100, nonWhitespace: true });
  }
  if (Object.hasOwn(value, 'description')) {
    validateString(value.description, '/description', errors, { max: 500 });
  }

  let framing = { terminator: 'cr' };
  if (required(value, 'framing', '', errors)) {
    if (!isPlainObject(value.framing)) {
      errors.push({ pointer: '/framing', code: 'not_an_object' });
    } else {
      unknownFields(value.framing, new Set(['terminator']), '/framing', errors);
      if (required(value.framing, 'terminator', '/framing', errors)) {
        if (typeof value.framing.terminator !== 'string') {
          errors.push({ pointer: '/framing/terminator', code: 'invalid_type' });
        } else if (!['cr', 'lf', 'crlf'].includes(value.framing.terminator)) {
          errors.push({ pointer: '/framing/terminator', code: 'invalid_value' });
        } else {
          framing = { terminator: value.framing.terminator };
        }
      }
    }
  }

  const connection = {
    maxConnections: 1,
    overLimit: 'refuse',
    idleTimeoutMs: 0,
    idleBehavior: 'close',
    startupQuietMs: 0,
    minCommandIntervalMs: 0,
  };
  if (Object.hasOwn(value, 'connection')) {
    if (!isPlainObject(value.connection)) {
      errors.push({ pointer: '/connection', code: 'not_an_object' });
    } else {
      unknownFields(value.connection, new Set(Object.keys(connection)), '/connection', errors);
      const integerRules = {
        maxConnections: [1, 32],
        startupQuietMs: [0, 600000],
        minCommandIntervalMs: [0, 60000],
      };
      for (const [key, [min, max]] of Object.entries(integerRules)) {
        if (Object.hasOwn(value.connection, key)
          && validateInteger(value.connection[key], `/connection/${key}`, errors, min, max)) {
          connection[key] = value.connection[key];
        }
      }
      if (Object.hasOwn(value.connection, 'idleTimeoutMs')) {
        const idle = value.connection.idleTimeoutMs;
        if (typeof idle !== 'number') {
          errors.push({ pointer: '/connection/idleTimeoutMs', code: 'invalid_type' });
        } else if (!Number.isSafeInteger(idle) || !(idle === 0 || (idle >= 1000 && idle <= 3600000))) {
          errors.push({ pointer: '/connection/idleTimeoutMs', code: 'invalid_value' });
        } else {
          connection.idleTimeoutMs = idle;
        }
      }
      for (const [key, choices] of [
        ['overLimit', ['refuse', 'accept_then_close']],
        ['idleBehavior', ['close', 'stop_responding']],
      ]) {
        if (Object.hasOwn(value.connection, key)) {
          if (typeof value.connection[key] !== 'string') {
            errors.push({ pointer: `/connection/${key}`, code: 'invalid_type' });
          } else if (!choices.includes(value.connection[key])) {
            errors.push({ pointer: `/connection/${key}`, code: 'invalid_value' });
          } else {
            connection[key] = value.connection[key];
          }
        }
      }
    }
  }

  const variables = Object.hasOwn(value, 'variables')
    ? validateVariables(value.variables, '/variables', errors)
    : {};
  const commands = Object.hasOwn(value, 'commands')
    ? validateCommands(value.commands, '/commands', variables, errors)
    : [];
  const notifications = Object.hasOwn(value, 'notifications')
    ? validateNotifications(value.notifications, '/notifications', variables, errors)
    : [];
  const noCaptureContext = {
    variables: new Set(Object.keys(variables)), captures: new Set(), allowCaptures: false,
  };
  let greeting = null;
  if (Object.hasOwn(value, 'greeting')) {
    if (transport === 'udp') {
      errors.push({ pointer: '/greeting', code: 'greeting_not_supported_for_udp' });
    } else {
      greeting = compileTemplate(value.greeting, '/greeting', noCaptureContext, errors);
    }
  }
  let unknownReply = null;
  if (Object.hasOwn(value, 'unknown')) {
    if (!isPlainObject(value.unknown)) {
      errors.push({ pointer: '/unknown', code: 'not_an_object' });
    } else {
      unknownFields(value.unknown, new Set(['reply']), '/unknown', errors);
      if (Object.hasOwn(value.unknown, 'reply')) {
        unknownReply = compileTemplate(
          value.unknown.reply,
          '/unknown/reply',
          noCaptureContext,
          errors,
          { nullable: true },
        );
      }
    }
  }

  if (errors.length > 0) {
    const retainedStructuralPointers = new Set();
    errors = errors.filter((error) => {
      if (!scan.structurallyInvalidPointers.has(error.pointer)) {
        return true;
      }
      if (retainedStructuralPointers.has(error.pointer)) {
        return false;
      }
      retainedStructuralPointers.add(error.pointer);
      return true;
    });
    return { ok: false, errors: sortErrorsInDocumentOrder(value, errors) };
  }
  const definition = deepFreeze({
    schemaVersion: 1,
    transport,
    name: value.name,
    description: value.description,
    framing,
    greeting,
    connection,
    variables,
    commands,
    notifications,
    unknownReply,
  });
  validatedDefinitions.add(definition);
  return { ok: true, definition };
}

function parseJsonPosition(message, text) {
  const positionMatch = /position\s+(\d+)/i.exec(message);
  const lineColumnMatch = /line\s+(\d+)\s+column\s+(\d+)/i.exec(message);
  const position = positionMatch === null ? null : Number(positionMatch[1]);
  let line = lineColumnMatch === null ? null : Number(lineColumnMatch[1]);
  let column = lineColumnMatch === null ? null : Number(lineColumnMatch[2]);
  if (position !== null && (line === null || column === null)) {
    const prefix = text.slice(0, position);
    line = prefix.split('\n').length;
    const lastLineBreak = prefix.lastIndexOf('\n');
    column = position - lastLineBreak;
  }
  return { position, line, column };
}

function parseDefinitionText(text) {
  if (typeof text !== 'string') {
    throw new TypeError('text must be a string');
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) {
    return { ok: false, errors: [{ pointer: '', code: 'file_too_large' }] };
  }
  const source = text.startsWith('\ufeff') ? text.slice(1) : text;
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    if (error instanceof RangeError) {
      return { ok: false, errors: [{ pointer: '', code: 'too_deep' }] };
    }
    return {
      ok: false,
      errors: [{ pointer: '', code: 'invalid_json', detail: parseJsonPosition(error.message, source) }],
    };
  }
  return validateDefinition(value);
}

function isValidatedDefinition(value) {
  return value !== null && typeof value === 'object' && validatedDefinitions.has(value);
}

module.exports = { parseDefinitionText, validateDefinition, isValidatedDefinition };
