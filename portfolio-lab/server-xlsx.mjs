import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

// Reuse the trusted SheetJS bundle already shipped with the browser app.
// No downloaded code or Excel contents are executed in this context.
const filename = fileURLToPath(new URL('./dist/vendor/xlsx.full.min.js', import.meta.url));
const library = {};
new Script(readFileSync(filename, 'utf8'), { filename }).runInNewContext(
  { exports: library, Buffer },
  { timeout: 10000 }
);
if (typeof library.read !== 'function' || typeof library.utils?.sheet_to_json !== 'function') {
  throw new Error('The bundled SheetJS library could not be loaded.');
}

export default library;
