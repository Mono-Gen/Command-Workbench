// Reads a user-chosen file safely: open it ONCE, check the same handle, read at most the limit.
// Checking with stat(path) and then reading by path would let the file be swapped in between
// (a huge file, a pipe, a device). The file system is injected so the checks can be tested.
async function readRegularFileLimited(fs, filePath, maxBytes) {
  let handle = null;
  try {
    handle = await fs.open(filePath, 'r');
    const stats = await handle.stat();
    if (!stats.isFile()) return { ok: false, code: 'not_a_file' };
    if (stats.size > maxBytes) return { ok: false, code: 'file_too_large' };

    // One byte more than the limit: if it is there, the file is larger than it claimed.
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
    if (bytesRead > maxBytes) return { ok: false, code: 'file_too_large' };
    return { ok: true, text: buffer.subarray(0, bytesRead).toString('utf8') };
  } catch (error) {
    return { ok: false, code: 'read_failed', errno: error && error.code };
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Nothing useful can be done if closing fails; the result is already decided.
      }
    }
  }
}

module.exports = { readRegularFileLimited };
