// A sample store over the bundled samples, for service tests (no samples folder, so the bundled ones are used).
const path = require('node:path');
const fsp = require('node:fs/promises');
const { createSampleStore } = require('../../src/main/sample-store');

const BUILTIN = path.join(__dirname, '..', '..', 'src', 'samples');

const bundledSampleStore = () => createSampleStore({ fs: fsp, folderDir: path.join(BUILTIN, '..', 'no-such-samples-folder'), builtinDir: BUILTIN });

module.exports = { bundledSampleStore, BUILTIN };
