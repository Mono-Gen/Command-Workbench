// Keeps the two language tables in sync and enforces the public-text rules.
const test = require('node:test');
const assert = require('node:assert/strict');

const ja = require('../../src/renderer/i18n/ja');
const en = require('../../src/renderer/i18n/en');

const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('both languages have exactly the same keys', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ja).sort());
});

test('both languages use the same {placeholders} for every key', () => {
  for (const key of Object.keys(ja)) {
    assert.deepEqual(placeholders(en[key]), placeholders(ja[key]), key);
  }
});

test('no value is empty', () => {
  for (const table of [ja, en]) {
    for (const [key, value] of Object.entries(table)) {
      assert.equal(typeof value, 'string', key);
      assert.ok(value.trim().length > 0, key);
    }
  }
});


test('every diagnostic hint id from the core has a title and a body in both languages', () => {
  const ids = [
    'connect_refused', 'connect_not_found', 'connect_unreachable', 'connect_timeout', 'connect_other',
    'maybe_booting', 'no_reply', 'check_terminator', 'silent_break', 'peer_closed_idle', 'connection_limit_maybe',
    'udp_no_reply', 'udp_other_source', 'udp_local_port_busy', 'udp_datagram_too_large',
  ];
  for (const table of [ja, en]) {
    for (const id of ids) {
      assert.ok(table[`hint.${id}.title`], `hint.${id}.title`);
      assert.ok(table[`hint.${id}.body`], `hint.${id}.body`);
    }
  }
});

test('every parse error code has a message', () => {
  const codes = [
    'empty_input', 'too_large', 'invalid_hex_escape', 'dangling_backslash', 'unknown_escape',
    'unclosed_bracket', 'empty_name', 'unknown_name', 'invalid_hex_literal', 'lone_surrogate',
    'invalid_hex_char', 'odd_hex_length',
  ];
  for (const table of [ja, en]) {
    for (const code of codes) assert.ok(table[`parse.${code}`], `parse.${code}`);
  }
});

test('every result code the main process can return has a message', () => {
  const codes = [
    'not_connected', 'cancelled', 'busy_confirming', 'busy', 'invalid_target', 'invalid_arguments', 'internal_error',
    'untrusted_sender', 'unknown_command', 'not_query', 'invalid_interval', 'already_running', 'queue_full',
    'write_failed', 'replace_failed', 'file_too_large', 'invalid_data', 'not_loaded', 'blocked_by_unreadable_file', 'parse_error',
    'too_long_to_confirm', 'invalid_local_port', 'rate_limited', 'too_large', 'unsupported',
  ];
  for (const table of [ja, en]) {
    for (const code of codes) assert.ok(table[`err.${code}`], `err.${code}`);
    for (const reason of ['read_only_blocks_set', 'read_only_blocks_unclassified', 'read_only_blocks_periodic', 'changed_before_send']) assert.ok(table[`blocked.${reason}`], reason);
  }
});

test('every periodic stop reason and every load status banner has a message', () => {
  for (const table of [ja, en]) {
    for (const reason of ['user', 'connection_closed', 'read_only', 'send_failed', 'shutdown']) assert.ok(table[`periodic.stopped.${reason}`], reason);
    for (const status of ['corrupt', 'invalid', 'unsupported', 'too_large', 'read_error']) assert.ok(table[`banner.load.${status}`], status);
  }
});

test('every definition error code, pattern reason, event, close reason and outcome of the device view has a message', () => {
  const groups = {
    'dev.defcode': ['duplicate_name', 'file_too_large', 'invalid_condition', 'invalid_json', 'invalid_name', 'invalid_notation',
      'invalid_pattern', 'invalid_schema_version', 'invalid_template', 'invalid_type', 'invalid_value', 'missing_field',
      'not_an_array', 'not_an_object', 'out_of_range', 'reserved_key', 'too_deep', 'too_many', 'type_mismatch',
      'unknown_field', 'unknown_reference', 'unsupported_schema_version'],
    'dev.defreason': ['empty', 'syntax', 'adjacent', 'duplicate_capture', 'multiple_star', 'too_many_captures'],
    'dev.event': ['listening', 'stopped', 'connection_opened', 'connection_closed', 'refused', 'idle', 'ignored', 'dropped', 'muted', 'omitted', 'server_error', 'variables'],
    'dev.closeReason': ['peer', 'idle', 'stop', 'fault', 'error', 'write_error', 'write_timeout', 'queue_overflow', 'rate_limit', 'no_message', 'oversize'],
    'dev.refusedReason': ['limit', 'startup', 'rate_limit'],
    'dev.outcome': ['matched', 'invalid', 'otherwise', 'unknown', 'unknown_undecodable', 'empty', 'reply_too_large'],
    'dev.overLimit': ['refuse', 'accept_then_close'],
    'dev.idleBehavior': ['close', 'stop_responding'],
    'dev.terminator': ['cr', 'lf', 'crlf'],
    'dev.err': ['no_definition', 'running', 'cancelled', 'invalid_host', 'invalid_port', 'listen_failed', 'listen_failed_inuse', 'already_running',
      'busy', 'invalid_definition', 'invalid_arguments', 'unknown_sample', 'read_failed', 'not_a_file', 'file_too_large', 'not_running', 'internal_error'],
  };
  for (const table of [ja, en]) {
    for (const [prefix, codes] of Object.entries(groups)) {
      for (const code of codes) assert.ok(table[`${prefix}.${code}`], `${prefix}.${code}`);
    }
  }
});

