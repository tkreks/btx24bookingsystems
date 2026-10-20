// Read-only доступ к PostgreSQL для агентов. Слои защиты:
//   1) роль agent_ro с правом только SELECT (docker/postgres/init/10-agent-readonly.sh);
//   2) транзакция BEGIN READ ONLY + statement_timeout, всегда ROLLBACK;
//   3) лексическая проверка: один оператор, только SELECT / WITH / EXPLAIN / TABLE / VALUES;
//   4) лимит строк и маскирование «секретных» колонок.
import pg from 'pg';
import { LIMITS } from '../config.mjs';
import { ToolInputError, isSensitiveColumn, redactSecrets } from '../security.mjs';

// Список намеренно узкий: слова, которые почти не встречаются как имена колонок. Основная
// защита — роль agent_ro и READ ONLY транзакция; эта проверка даёт понятную ошибку заранее.
const FORBIDDEN = /\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|copy|call|vacuum|reindex|cluster|lock|listen|notify|unlisten|refresh|prepare|execute|deallocate|discard|checkpoint|set_config|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|lo_import|lo_export|dblink\w*|pg_read_\w*|pg_ls_\w*)\b/i;

/** Убирает комментарии и содержимое строковых литералов/идентификаторов в кавычках. */
export function stripSqlLiterals(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g, "''")
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '"x"');
}

/** Возвращает нормализованный SQL или бросает ToolInputError. */
export function assertReadOnlySql(sql) {
  if (typeof sql !== 'string' || !sql.trim()) throw new ToolInputError('INVALID_SQL', 'SQL is empty.');
  if (sql.length > 10_000) throw new ToolInputError('INVALID_SQL', 'SQL is too long (max 10000 chars).');
  const trimmed = sql.trim().replace(/;\s*$/, '');
  const bare = stripSqlLiterals(trimmed);
  if (bare.includes(';')) throw new ToolInputError('MULTIPLE_STATEMENTS', 'Only a single statement is allowed.');
  const first = /^\s*\(?\s*([a-z]+)/i.exec(bare)?.[1]?.toLowerCase();
  if (!['select', 'with', 'explain', 'table', 'values', 'show'].includes(first ?? '')) {
    throw new ToolInputError('NOT_READ_ONLY', 'Only SELECT / WITH / EXPLAIN / TABLE / VALUES / SHOW are allowed.');
  }
  const forbidden = FORBIDDEN.exec(first === 'explain' ? bare.replace(/^\s*explain\s*(\([^)]*\))?\s*(analyze\s+)?/i, '') : bare);
  if (forbidden) {
    throw new ToolInputError('NOT_READ_ONLY', `Keyword "${forbidden[1]}" is not allowed in db_query.`);
  }
  if (/\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/i.test(bare)) {
    throw new ToolInputError('NOT_READ_ONLY', 'Row-locking clauses (FOR UPDATE/SHARE) are not allowed.');
  }
  return { sql: trimmed, kind: first };
}

function maskRow(row, fields) {
  const out = {};
  for (const f of fields) {
    const v = row[f.name];
    if (v === null || v === undefined) out[f.name] = v ?? null;
    else if (isSensitiveColumn(f.name)) out[f.name] = '[REDACTED]';
    else if (typeof v === 'string') out[f.name] = redactSecrets(v.length > 500 ? `${v.slice(0, 500)}…` : v);
    else if (v instanceof Date) out[f.name] = v.toISOString();
    else if (typeof v === 'bigint') out[f.name] = v.toString();
    else if (Buffer.isBuffer(v)) out[f.name] = `<bytea ${v.length} bytes>`;
    else out[f.name] = v;
  }
  return out;
}

async function withReadOnlyClient(url, fn) {
  if (!url) {
    return {
      ok: false,
      code: 'DB_NOT_CONFIGURED',
      message: 'AGENT_DB_PASSWORD (или BTX_AGENT_DB_URL) не задан в корневом .env — read-only доступ к БД не настроен.',
    };
  }
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: LIMITS.dbConnectTimeoutMs,
    statement_timeout: LIMITS.dbStatementTimeoutMs,
    query_timeout: LIMITS.dbStatementTimeoutMs + 1000,
    application_name: 'btx-dev-mcp',
  });
  try {
    await client.connect();
  } catch (err) {
    return { ok: false, code: 'DB_UNAVAILABLE', message: redactSecrets(err.message), hint: 'Запущен ли контейнер db (`docker compose up -d db`)? Совпадает ли DB_HOST_PORT?' };
  }
  try {
    await client.query('BEGIN READ ONLY');
    return await fn(client);
  } catch (err) {
    return { ok: false, code: 'DB_ERROR', message: redactSecrets(err.message), ...(err.position ? { position: Number(err.position) } : {}) };
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  }
}

export async function dbQuery(url, { sql, maxRows }) {
  const { sql: checked, kind } = assertReadOnlySql(sql);
  const wrapped = ['select', 'with', 'table', 'values'].includes(kind)
    ? `SELECT * FROM (\n${checked}\n) AS agent_q LIMIT ${maxRows + 1}`
    : checked;
  return withReadOnlyClient(url, async (client) => {
    const res = await client.query({ text: wrapped, rowMode: 'object' });
    const fields = res.fields ?? [];
    const rows = res.rows.slice(0, maxRows).map((r) => maskRow(r, fields));
    return {
      ok: true,
      columns: fields.map((f) => f.name),
      rowCount: rows.length,
      truncated: res.rows.length > maxRows,
      rows,
    };
  });
}

export async function dbSchema(url, { table }) {
  return withReadOnlyClient(url, async (client) => {
    const tables = await client.query(
      `SELECT c.relname AS name, c.relkind AS kind, c.reltuples::bigint AS approx_rows,
              obj_description(c.oid, 'pg_class') AS comment
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','p')
          AND ($1::text IS NULL OR c.relname = $1)
        ORDER BY c.relname`,
      [table ?? null],
    );
    if (!table) {
      const migrations = await client
        .query(`SELECT migration_name, finished_at FROM "_prisma_migrations" ORDER BY started_at DESC LIMIT 5`)
        .then((r) => r.rows)
        .catch(() => null);
      return {
        ok: true,
        tables: tables.rows.map((t) => ({ name: t.name, kind: { r: 'table', v: 'view', m: 'matview', p: 'partitioned' }[t.kind], approxRows: Number(t.approx_rows), comment: t.comment })),
        recentMigrations: migrations,
      };
    }
    if (tables.rowCount === 0) return { ok: false, code: 'NOT_FOUND', message: `Table "${table}" not found in schema public.` };
    const columns = await client.query(
      `SELECT column_name AS name, data_type AS type, udt_name, is_nullable = 'YES' AS nullable, column_default AS "default"
         FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      [table],
    );
    const constraints = await client.query(
      `SELECT con.conname AS name, con.contype AS type, pg_get_constraintdef(con.oid) AS definition
         FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = $1 ORDER BY con.conname`,
      [table],
    );
    const indexes = await client.query(`SELECT indexname AS name, indexdef AS definition FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1 ORDER BY indexname`, [table]);
    const typeNames = { p: 'primary key', f: 'foreign key', u: 'unique', c: 'check', x: 'exclusion', t: 'trigger' };
    return {
      ok: true,
      table,
      columns: columns.rows,
      constraints: constraints.rows.map((c) => ({ ...c, type: typeNames[c.type] ?? c.type })),
      indexes: indexes.rows,
    };
  });
}
