// Защита путей и редактирование секретов. Любой путь из tool-call проходит через resolveInRepo,
// любой текст, уходящий агенту, — через redactSecrets.
import fs from 'node:fs';
import path from 'node:path';
import { DENY_SEGMENTS, isSecretLikePath } from './config.mjs';

export class ToolInputError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function toPosix(p) {
  return p.split(path.sep).join('/');
}

/** true, если путь (относительный, posix) запрещён к чтению/индексации. */
export function isDeniedPath(relPath) {
  const segments = relPath.split('/');
  if (segments.some((s) => DENY_SEGMENTS.has(s))) return true;
  return isSecretLikePath(relPath);
}

/**
 * Превращает пользовательский путь в абсолютный путь внутри корня репозитория.
 * Отклоняет: абсолютные пути, выход за корень (в т.ч. через симлинки), запрещённые файлы.
 */
export function resolveInRepo(root, userPath) {
  if (typeof userPath !== 'string' || userPath.length === 0 || userPath.length > 1024) {
    throw new ToolInputError('INVALID_PATH', 'Path must be a non-empty repo-relative string.');
  }
  if (userPath.includes('\0')) throw new ToolInputError('INVALID_PATH', 'Path contains a NUL byte.');
  if (path.isAbsolute(userPath) || /^[a-zA-Z]:[\\/]/.test(userPath) || userPath.startsWith('\\\\')) {
    throw new ToolInputError('PATH_OUTSIDE_REPO', 'Absolute paths are not allowed; pass a repo-relative path.');
  }
  const abs = path.resolve(root, userPath);
  const rel = toPosix(path.relative(root, abs));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ToolInputError('PATH_OUTSIDE_REPO', 'Path escapes the repository root.');
  }
  if (isDeniedPath(rel)) {
    throw new ToolInputError('PATH_DENIED', `Access to "${rel}" is denied (generated, dependency or secret-like file).`);
  }
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch {
    throw new ToolInputError('NOT_FOUND', `File not found: ${rel}`);
  }
  const realRoot = fs.realpathSync(root);
  const realRel = toPosix(path.relative(realRoot, real));
  if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
    throw new ToolInputError('PATH_OUTSIDE_REPO', 'Path resolves (via symlink) outside the repository root.');
  }
  if (isDeniedPath(realRel)) {
    throw new ToolInputError('PATH_DENIED', `Access to "${realRel}" is denied.`);
  }
  return { abs: real, rel };
}

const REDACTED = '[REDACTED]';

const SECRET_PATTERNS = [
  // URL с паролем: scheme://user:password@host
  { re: /([a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:)([^\s@'"]+)(@)/gi, replace: `$1${REDACTED}$3` },
  // KEY=value / "key": "value" для ключей, похожих на секреты (в т.ч. Битрикс24 AUTH_ID/REFRESH_ID)
  {
    re: /((?:password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?id|refresh[_-]?id|access[_-]?token|refresh[_-]?token|encryption[_-]?key)[a-z0-9_]*["']?\s*[:=]\s*["']?)([^\s"',;&]{4,})/gi,
    replace: `$1${REDACTED}`,
  },
  // Authorization: Bearer xxx
  { re: /(authorization:\s*(?:bearer|basic)\s+)([^\s"']+)/gi, replace: `$1${REDACTED}` },
  // JWT
  { re: /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/g, replace: REDACTED },
  // PEM-блоки
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: REDACTED },
  // Входящие вебхуки Битрикс24: https://portal/rest/<user_id>/<code>/
  { re: /(\/rest\/\d+\/)([a-z0-9]{8,})(\/)/gi, replace: `$1${REDACTED}$3` },
];

export function redactSecrets(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const { re, replace } of SECRET_PATTERNS) out = out.replace(re, replace);
  return out;
}

/** Колонки БД, значения которых всегда скрываются в db_query. */
export function isSensitiveColumn(name) {
  return /(password|passwd|secret|token|auth_?id|refresh_?id|api_?key|private_?key|encryption|credential|hash)/i.test(name);
}
