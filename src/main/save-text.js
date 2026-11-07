// Writes a text file the user picked in a native dialog, without ever leaving a half-written file:
// write to a new temporary file in the same folder, flush it, then replace the target. The file
// system is injected so the failure paths can be tested.
const MAX_SAVE_BYTES = 32 * 1024 * 1024;

async function saveTextAtomic(fs, filePath, text, { randomName = () => Math.random().toString(36).slice(2) } = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0 || typeof text !== 'string') {
    return { ok: false, code: 'invalid_arguments' };
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_SAVE_BYTES) return { ok: false, code: 'file_too_large' };

  const temp = `${filePath}.${randomName()}.tmp`;
  let handle = null;
  let created = false;
  try {
    // 'wx': never write into a file that already exists under the temporary name.
    handle = await fs.open(temp, 'wx');
    created = true;
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temp, filePath);
    return { ok: true };
  } catch (error) {
    if (handle) {
      try { await handle.close(); } catch { /* the failure being reported is the first one */ }
    }
    // Only a file this call created is removed: a pre-existing one belongs to someone else.
    if (created) {
      try { await fs.rm(temp, { force: true }); } catch { /* nothing more can be done */ }
    }
    return { ok: false, code: 'write_failed', errno: error && error.code };
  }
}

module.exports = { saveTextAtomic, MAX_SAVE_BYTES };
