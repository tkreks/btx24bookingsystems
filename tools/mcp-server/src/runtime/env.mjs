// Чтение разрешённых ключей из корневого .env. Значения используются только внутри сервера
// (строка подключения к БД, порты) и никогда не возвращаются агенту.
import fs from 'node:fs';
import path from 'node:path';
import { ENV_ALLOWLIST } from '../config.mjs';

export function parseDotenv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    out[m[1]] = value;
  }
  return out;
}

/** Переменные процесса имеют приоритет над .env; берутся только ключи из ENV_ALLOWLIST. */
export function loadRuntimeEnv(root, processEnv = process.env) {
  let fileVars = {};
  try {
    fileVars = parseDotenv(fs.readFileSync(path.join(root, '.env'), 'utf8'));
  } catch {
    // .env может отсутствовать — тогда работают значения по умолчанию.
  }
  const env = {};
  for (const key of ENV_ALLOWLIST) {
    const v = processEnv[key] ?? fileVars[key];
    if (v !== undefined && v !== '') env[key] = v;
  }
  return env;
}

export function agentDbUrl(env) {
  if (env.BTX_AGENT_DB_URL) return env.BTX_AGENT_DB_URL;
  if (!env.AGENT_DB_PASSWORD) return null;
  const port = env.DB_HOST_PORT ?? '53306';
  const db = env.DB_NAME ?? 'btx24';
  return `mysql://agent_ro:${encodeURIComponent(env.AGENT_DB_PASSWORD)}@127.0.0.1:${port}/${encodeURIComponent(db)}`;
}

export function appBaseUrl(env) {
  return `http://127.0.0.1:${env.APP_HOST_PORT ?? '3080'}`;
}
