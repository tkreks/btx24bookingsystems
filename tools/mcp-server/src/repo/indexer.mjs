// Лёгкий лексический индексатор: символы TS/JS, HTTP-эндпоинты NestJS, модели/enum Prisma,
// заголовки Markdown. Не компилятор — диапазоны строк приблизительные (по балансу скобок),
// поэтому read_source всегда показывает реальный текст файла, а не «понимание» индекса.
import fs from 'node:fs';
import path from 'node:path';
import { languageForPath } from '../config.mjs';
import { listCorpusFiles, readTextIfSmall } from './fileset.mjs';

const TS_DECL =
  /^\s*(export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(class|interface|type|enum|function\*?|const|let)\s+([A-Za-z_$][\w$]*)/;
const NEST_CONTROLLER = /@Controller\(\s*(?:['"`]([^'"`]*)['"`])?/;
const NEST_ROUTE = /@(Get|Post|Put|Patch|Delete|All|Options|Head)\(\s*(?:['"`]([^'"`]*)['"`])?/;
const METHOD_NAME = /^\s*(?:public\s+|private\s+|protected\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/;
const PRISMA_BLOCK = /^\s*(model|enum|view|type)\s+([A-Za-z_]\w*)\s*\{/;
const MD_HEADING = /^(#{1,4})\s+(.+?)\s*#*\s*$/;
const SQL_DDL = /^\s*(?:CREATE|ALTER)\s+(?:UNIQUE\s+)?(TABLE|INDEX|TYPE|EXTENSION|VIEW|FUNCTION|TRIGGER)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:ON\s+)?"?([\w.]+)"?/i;

/** Глобальный префикс API (apps/api/src/main.ts → app.setGlobalPrefix). */
export const API_GLOBAL_PREFIX = 'api';

function blockEnd(lines, startIdx) {
  let depth = 0;
  let seenOpen = false;
  for (let i = startIdx; i < lines.length && i < startIdx + 2000; i++) {
    const line = lines[i].replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '').replace(/\/\/.*$/, '');
    for (const ch of line) {
      if (ch === '{') {
        depth++;
        seenOpen = true;
      } else if (ch === '}') depth--;
    }
    if (seenOpen && depth <= 0) return i;
    if (!seenOpen && /;\s*$/.test(line)) return i; // однострочный type/const
  }
  return startIdx;
}

function joinRoute(...parts) {
  const joined = parts
    .filter((p) => p !== undefined && p !== null && p !== '')
    .map((p) => String(p).replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return `/${joined}`;
}

export function indexFile(relPath, text) {
  const lang = languageForPath(relPath);
  const lines = text.split(/\r?\n/);
  const symbols = [];
  const endpoints = [];

  if (lang === 'typescript' || lang === 'javascript') {
    let controllerBase = null;
    let pendingRoute = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const ctrl = NEST_CONTROLLER.exec(line);
      if (ctrl) controllerBase = ctrl[1] ?? '';
      const route = NEST_ROUTE.exec(line);
      if (route && controllerBase !== null) {
        pendingRoute = { method: route[1].toUpperCase(), sub: route[2] ?? '', line: i + 1 };
        continue;
      }
      if (pendingRoute && !line.trim().startsWith('@')) {
        const m = METHOD_NAME.exec(line);
        if (m) {
          endpoints.push({
            kind: 'endpoint',
            name: `${pendingRoute.method} ${joinRoute(API_GLOBAL_PREFIX, controllerBase, pendingRoute.sub)}`,
            handler: m[1],
            path: relPath,
            line: pendingRoute.line,
            endLine: blockEnd(lines, i) + 1,
          });
          pendingRoute = null;
        }
      }
      const decl = TS_DECL.exec(line);
      if (decl && (decl[1] || /^\S/.test(line))) {
        symbols.push({
          kind: 'symbol',
          type: decl[2].replace('*', ''),
          name: decl[3],
          exported: Boolean(decl[1]) || /^\s*export\s+default/.test(line),
          path: relPath,
          line: i + 1,
          endLine: blockEnd(lines, i) + 1,
        });
      }
    }
  } else if (lang === 'prisma') {
    for (let i = 0; i < lines.length; i++) {
      const m = PRISMA_BLOCK.exec(lines[i]);
      if (m) {
        symbols.push({ kind: 'prisma', type: m[1], name: m[2], exported: true, path: relPath, line: i + 1, endLine: blockEnd(lines, i) + 1 });
      }
    }
  } else if (lang === 'sql') {
    for (let i = 0; i < lines.length; i++) {
      const m = SQL_DDL.exec(lines[i]);
      if (m) symbols.push({ kind: 'sql', type: m[1].toLowerCase(), name: m[2], exported: false, path: relPath, line: i + 1, endLine: i + 1 });
    }
  } else if (lang === 'markdown') {
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*```/.test(lines[i])) inFence = !inFence;
      if (inFence) continue;
      const m = MD_HEADING.exec(lines[i]);
      if (m) symbols.push({ kind: 'docs', type: `h${m[1].length}`, name: m[2], exported: false, path: relPath, line: i + 1, endLine: i + 1 });
    }
  }
  return { symbols, endpoints, lineCount: lines.length };
}

/**
 * Индекс репозитория с инкрементальным обновлением по mtime/size. Каждый вызов refresh()
 * заново перечисляет файлы, поэтому новые/удалённые файлы видны без перезапуска сервера.
 */
export class RepoIndex {
  constructor(root) {
    this.root = root;
    this.files = new Map(); // rel -> { mtimeMs, size, text, symbols, endpoints, lineCount }
    this.refreshedAt = null;
  }

  refresh() {
    const seen = new Set();
    for (const rel of listCorpusFiles(this.root)) {
      seen.add(rel);
      const abs = path.join(this.root, rel);
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      const cached = this.files.get(rel);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) continue;
      const text = readTextIfSmall(abs);
      if (text === null) {
        this.files.set(rel, { mtimeMs: st.mtimeMs, size: st.size, text: null, symbols: [], endpoints: [], lineCount: 0, tooLarge: true });
        continue;
      }
      this.files.set(rel, { mtimeMs: st.mtimeMs, size: st.size, text, ...indexFile(rel, text) });
    }
    for (const rel of this.files.keys()) if (!seen.has(rel)) this.files.delete(rel);
    this.refreshedAt = new Date().toISOString();
    return this;
  }

  *entries() {
    yield* this.files.entries();
  }

  allSymbols() {
    const out = [];
    for (const [, f] of this.files) out.push(...f.symbols, ...f.endpoints);
    return out;
  }
}

/** Стабильный идентификатор символа: `<path>#<name>@<line>`. */
export function symbolId(sym) {
  return `${sym.path}#${sym.name}@${sym.line}`;
}

export function parseSymbolId(id) {
  const m = /^(.+)#(.+)@(\d+)$/.exec(id ?? '');
  if (!m) return null;
  return { path: m[1], name: m[2], line: Number(m[3]) };
}
