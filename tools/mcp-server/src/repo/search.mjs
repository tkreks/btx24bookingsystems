// Лексический поиск по индексу: символы, эндпоинты, Prisma, SQL, docs, пути и полнотекст.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { symbolId } from './indexer.mjs';

const ALIASES = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../domain-aliases.json'), 'utf8'),
);

/** Разбивает строку на нижнерегистровые токены, включая части camelCase/snake_case. */
export function tokenize(text) {
  const spaced = String(text)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return spaced
    .toLowerCase()
    .split(/[^a-zа-яё0-9]+/i)
    .filter((t) => t.length >= 2);
}

/** Токены запроса + синонимы из domain-aliases.json (оригинальные токены весят больше). */
export function expandQuery(query) {
  const base = tokenize(query);
  const weights = new Map();
  for (const t of base) {
    weights.set(t, Math.max(weights.get(t) ?? 0, 1));
    for (const alias of ALIASES[t] ?? []) weights.set(alias, Math.max(weights.get(alias) ?? 0, 0.6));
  }
  return weights;
}

function scoreTokens(haystackTokens, weights) {
  if (weights.size === 0) return 0;
  const set = new Set(haystackTokens);
  let score = 0;
  for (const [t, w] of weights) {
    if (set.has(t)) score += w;
    else if (t.length >= 4 && haystackTokens.some((h) => h.startsWith(t) || t.startsWith(h))) score += w * 0.5;
  }
  return score;
}

const KIND_FILTERS = {
  symbol: (s) => s.kind === 'symbol',
  endpoint: (s) => s.kind === 'endpoint',
  prisma: (s) => s.kind === 'prisma' || s.kind === 'sql',
  docs: (s) => s.kind === 'docs',
};

function inScope(rel, scope) {
  return !scope || rel === scope || rel.startsWith(scope.endsWith('/') ? scope : `${scope}/`);
}

/**
 * kind: symbol | endpoint | prisma | docs | path | text | undefined (всё, кроме text).
 * Пустой query допустим для endpoint/prisma — тогда возвращается полный список.
 */
export function search(index, { query = '', kind, scope, limit }) {
  const weights = expandQuery(query);
  const results = [];

  if (kind === 'text') {
    for (const [rel, f] of index.entries()) {
      if (!inScope(rel, scope) || !f.text) continue;
      const lines = f.text.split(/\r?\n/);
      let perFile = 0;
      for (let i = 0; i < lines.length && perFile < 3; i++) {
        const lower = lines[i].toLowerCase();
        let s = 0;
        for (const [t, w] of weights) if (lower.includes(t)) s += w;
        if (s > 0) {
          results.push({ kind: 'text', path: rel, line: i + 1, snippet: lines[i].trim().slice(0, 200), score: s });
          perFile++;
        }
      }
    }
  } else if (kind === 'path') {
    for (const [rel] of index.entries()) {
      if (!inScope(rel, scope)) continue;
      const s = scoreTokens(tokenize(rel), weights) + (rel.toLowerCase().includes(query.toLowerCase()) ? 2 : 0);
      if (s > 0) results.push({ kind: 'path', path: rel, score: s });
    }
  } else {
    const filter = kind ? KIND_FILTERS[kind] : () => true;
    const listAll = weights.size === 0 && (kind === 'endpoint' || kind === 'prisma');
    for (const sym of index.allSymbols()) {
      if (!filter(sym) || !inScope(sym.path, scope)) continue;
      let s;
      if (listAll) s = 1;
      else {
        const nameTokens = tokenize(sym.name);
        s = scoreTokens(nameTokens, weights) * 2 + scoreTokens(tokenize(sym.path), weights) * 0.5;
        if (sym.name.toLowerCase() === query.trim().toLowerCase()) s += 5;
        if (sym.handler) s += scoreTokens(tokenize(sym.handler), weights);
      }
      if (s <= 0) continue;
      if (sym.exported) s += 0.1;
      results.push({
        kind: sym.kind,
        type: sym.type,
        name: sym.name,
        ...(sym.handler ? { handler: sym.handler } : {}),
        path: sym.path,
        line: sym.line,
        endLine: sym.endLine,
        symbol_id: symbolId(sym),
        score: Math.round(s * 100) / 100,
      });
    }
  }

  results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0));
  return { total: results.length, results: results.slice(0, limit) };
}
