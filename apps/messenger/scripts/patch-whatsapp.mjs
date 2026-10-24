import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { patchWhatsAppUtils } from '../src/whatsapp-compat.ts';
const require = createRequire(import.meta.url);
const path = require.resolve('whatsapp-web.js/src/util/Injected/Utils.js');
const source = await readFile(path, 'utf8'); const patched = patchWhatsAppUtils(source);
if (patched !== source) await writeFile(path, patched);
