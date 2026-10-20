// Реестр инструментов: имя, описание, входная схема (zod), обработчик. Один источник правды
// для MCP (server.mjs) и CLI (cli.mjs) — добавляйте инструмент только здесь.
import { z } from 'zod';
import { LIMITS } from './config.mjs';

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const TOOLS = [
  {
    name: 'project_overview',
    title: 'Project overview',
    description:
      'Workspaces, modules (with/without MODULE.md), key docs, git branch/dirty state, npm scripts and index stats. Call once at the start of an unfamiliar session instead of reading the whole repository.',
    inputSchema: {},
    run: (core) => core.projectOverview(),
  },
  {
    name: 'search_code',
    title: 'Search code',
    description:
      'Lexical search (RU/EN, domain glossary-aware) over symbols, NestJS HTTP endpoints, Prisma models/SQL migrations, docs headings, paths or full text. kind="endpoint" or "prisma" with an empty query lists everything. Returns symbol_id values for read_source.',
    inputSchema: {
      query: z.string().max(LIMITS.maxQueryLength).optional().describe('What to look for, e.g. "booking overlap" or "бронь ресурса".'),
      kind: z.enum(['symbol', 'endpoint', 'prisma', 'docs', 'path', 'text']).optional().describe('Omit to search symbols+endpoints+prisma+docs together.'),
      scope: z.string().optional().describe('Repo-relative path prefix, e.g. "apps/api/src/modules/bookings".'),
      limit: z.number().int().positive().max(LIMITS.searchMaxLimit).optional(),
    },
    run: (core, a) => core.searchCode(a),
  },
  {
    name: 'read_source',
    title: 'Read source fragment',
    description: `Read an exact fragment of a repo file by symbol_id (from search_code) or path + line range, max ${LIMITS.sourceMaxLines} lines per call. Returns a hash; pass it back as expected_hash to detect stale references. Secret-like files (.env, keys), node_modules, dist and generated code are denied.`,
    inputSchema: {
      symbol_id: z.string().optional(),
      path: z.string().optional().describe('Repo-relative path.'),
      start_line: z.number().int().positive().optional(),
      end_line: z.number().int().positive().optional(),
      expected_hash: z.string().optional(),
    },
    run: (core, a) => core.readSource(a),
  },
  {
    name: 'get_module_context',
    title: 'Get module context',
    description:
      'Curated MODULE.md plus endpoints, exported symbols, tests and files of one module (an apps/api/src/modules/* or apps/web/src/features/* directory, or shared / mcp-server / prisma).',
    inputSchema: { module: z.string().min(1).describe('Module name, e.g. "health", "bookings", "shared".') },
    run: (core, a) => core.getModuleContext(a),
  },
  {
    name: 'get_task_state',
    title: 'Get task state',
    description: 'Read a local task checkpoint .agent/tasks/<task_id>.md (gitignored). A hint for resuming work, not a source of truth.',
    inputSchema: { task_id: z.string().min(1) },
    run: (core, a) => core.getTaskState(a),
  },
  {
    name: 'env_status',
    title: 'Environment status',
    description: 'State of docker compose services (db, app: running/healthy, ports) and the app /api/health response. Read-only; does not start or stop anything.',
    inputSchema: {},
    run: (core) => core.envStatus(),
  },
  {
    name: 'app_logs',
    title: 'Container logs',
    description: `Last lines of a docker compose service log (default service "app", default ${LIMITS.logsDefaultTail}, max ${LIMITS.logsMaxTail} lines), optionally filtered by substring. Secrets are redacted.`,
    inputSchema: {
      service: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/).optional(),
      tail: z.number().int().positive().max(LIMITS.logsMaxTail).optional(),
      since: z.string().optional().describe('Relative time like 30s, 15m, 2h, 1d.'),
      grep: z.string().max(200).optional().describe('Case-insensitive substring filter.'),
    },
    run: (core, a) => core.appLogs(a),
  },
  {
    name: 'db_schema',
    title: 'Database schema',
    description:
      'Live PostgreSQL schema via the read-only agent_ro role: without "table" — list of tables/views with approximate row counts and recent Prisma migrations; with "table" — columns, constraints (incl. EXCLUDE), indexes.',
    inputSchema: { table: z.string().optional() },
    run: (core, a) => core.dbSchema(a),
  },
  {
    name: 'db_query',
    title: 'Read-only SQL query',
    description: `Run ONE read-only statement (SELECT / WITH / EXPLAIN / TABLE / VALUES / SHOW) as agent_ro inside a READ ONLY transaction with a ${LIMITS.dbStatementTimeoutMs} ms timeout. Rows capped (default ${LIMITS.dbDefaultRows}, max ${LIMITS.dbMaxRows}); token/secret/password-like columns are masked. Table names from Prisma are PascalCase — quote them: SELECT * FROM "Booking".`,
    inputSchema: {
      sql: z.string().min(1).max(10_000),
      max_rows: z.number().int().positive().max(LIMITS.dbMaxRows).optional(),
    },
    run: (core, a) => core.dbQuery(a),
  },
].map((t) => ({ ...t, annotations: RO }));

export function findTool(name) {
  return TOOLS.find((t) => t.name === name);
}
