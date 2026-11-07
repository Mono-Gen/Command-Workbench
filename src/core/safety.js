// Safety rules for sending to a real device. A command with no recognized `kind` is treated as
// the unsafe case (it may change device state), never as a query. The main process must
// re-check these: the renderer is not a trust boundary.
function validateCommand(command) {
  if (command === null || typeof command !== 'object') {
    throw new TypeError('command must be an object');
  }
}

function isSendAllowed(command, { readOnly }) {
  validateCommand(command);
  if (!readOnly || command.kind === 'query') {
    return { allowed: true };
  }
  if (command.kind === 'set') {
    return { allowed: false, reason: 'read_only_blocks_set' };
  }
  return { allowed: false, reason: 'read_only_blocks_unclassified' };
}

function canBePeriodic(command) {
  validateCommand(command);
  if (command.kind === 'query') {
    return { allowed: true };
  }
  return { allowed: false, reason: 'not_query' };
}

module.exports = { isSendAllowed, canBePeriodic };
