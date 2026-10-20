// Перечисление файлов корпуса. Без git: обычный обход каталогов (корпус маленький),
// так новые неотслеживаемые файлы тоже сразу видны.
import fs from 'node:fs';
import path from 'node:path';
import { CORPUS_ROOTS, LIMITS, languageForPath } from '../config.mjs';
import { isDeniedPath, toPosix } from '../security.mjs';

function walk(root, relDir, out) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, relDir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const rel = relDir ? `${relDir}/${e.name}` : e.name;
    if (isDeniedPath(rel)) continue;
    if (e.isDirectory()) walk(root, rel, out);
    else if (e.isFile() && languageForPath(rel)) out.push(rel);
  }
}

/** Список файлов корпуса (posix, относительно root), отсортированный. */
export function listCorpusFiles(root) {
  const out = [];
  for (const entry of CORPUS_ROOTS) {
    const abs = path.join(root, entry);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(root, toPosix(entry), out);
    else if (st.isFile() && !isDeniedPath(entry) && languageForPath(entry)) out.push(toPosix(entry));
  }
  return [...new Set(out)].sort();
}

/** Читает файл, если он не слишком большой; иначе null. */
export function readTextIfSmall(absPath) {
  const st = fs.statSync(absPath);
  if (st.size > LIMITS.maxFileBytesToScan) return null;
  return fs.readFileSync(absPath, 'utf8');
}
