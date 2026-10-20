// Конфигурация MCP-сервера: корпус индексации, запреты, бюджеты ответов, лимиты.
// Только данные и маленькие чистые функции — без динамических импортов и eval.

/** Что индексируется (пути относительно корня репозитория; префиксы). */
export const CORPUS_ROOTS = [
  'apps/api/src',
  'apps/api/prisma/schema.prisma',
  'apps/api/prisma/migrations',
  'apps/web/src',
  'packages/shared/src',
  'tools/mcp-server/src',
  'docs',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'README.md',
  'docker-compose.yml',
  'Dockerfile',
  '.env.example',
];

export const LANGUAGE_BY_EXT = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.mjs': 'javascript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.prisma': 'prisma',
  '.sql': 'sql',
  '.md': 'markdown',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.json': 'json',
  '.css': 'css',
};

/** Сегменты пути, которые запрещены всегда (и для индекса, и для read_source). */
export const DENY_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  'generated',
  '.vite',
  '.turbo',
]);

const SECRET_EXT = /\.(pem|key|crt|pfx|p12|jks|keystore)$/i;

/** Файлы, похожие на секреты. `.env.example` — единственный разрешённый env-файл. */
export function isSecretLikePath(relPath) {
  const base = relPath.split('/').pop() ?? relPath;
  if (base === '.env.example') return false;
  if (base.startsWith('.env')) return true;
  if (SECRET_EXT.test(base)) return true;
  if (/(^|[._-])(secret|secrets|credentials)([._-]|$)/i.test(base)) return true;
  if (/^id_(rsa|ed25519|ecdsa|dsa)/.test(base)) return true;
  return false;
}

export const RESPONSE_BUDGET_BYTES = {
  overview: 6000,
  search: 8000,
  source: 14000,
  module: 10000,
  task_state: 6000,
  runtime: 12000,
  db: 16000,
};

export const HARD_RESPONSE_CAP_BYTES = 32_000;

export const LIMITS = {
  maxQueryLength: 500,
  searchDefaultLimit: 10,
  searchMaxLimit: 20,
  sourceMaxLines: 250,
  maxFileBytesToScan: 1_000_000,
  logsDefaultTail: 200,
  logsMaxTail: 1000,
  dbDefaultRows: 50,
  dbMaxRows: 200,
  dbStatementTimeoutMs: 5000,
  dbConnectTimeoutMs: 3000,
  commandTimeoutMs: 10_000,
  httpTimeoutMs: 3000,
};

/** Ключи корневого .env, которые сервер вправе прочитать (значения наружу не отдаются). */
export const ENV_ALLOWLIST = ['POSTGRES_DB', 'DB_HOST_PORT', 'AGENT_DB_PASSWORD', 'APP_HOST_PORT', 'BTX_AGENT_DB_URL'];

/** Где лежат модули — для get_module_context и project_overview. */
export const MODULE_ROOTS = [
  { prefix: 'apps/api/src/modules/', kind: 'api' },
  { prefix: 'apps/web/src/features/', kind: 'web' },
];

/** Отдельные «модули» верхнего уровня. */
export const STANDALONE_MODULES = {
  shared: 'packages/shared',
  'mcp-server': 'tools/mcp-server',
  prisma: 'apps/api/prisma',
};

export function languageForPath(relPath) {
  const dot = relPath.lastIndexOf('.');
  if (dot === -1) return null;
  return LANGUAGE_BY_EXT[relPath.slice(dot)] ?? null;
}
