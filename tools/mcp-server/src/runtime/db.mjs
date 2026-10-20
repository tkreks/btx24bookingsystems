// Read-only доступ к MariaDB для агентов. Слои защиты:
//   1) пользователь agent_ro только с SELECT/SHOW VIEW (docker/db/init/10-agent-readonly.sh);
//   2) транзакция START TRANSACTION READ ONLY + max_statement_time, всегда ROLLBACK;
//   3) лексическая проверка: один оператор, только SELECT / WITH / EXPLAIN / SHOW / DESCRIBE;
//   4) лимит строк (sql_select_limit) и маскирование «секретных» колонок.
import mysql from 'mysql2/promise';
import { LIMITS } from '../config.mjs';
import { ToolInputError, isSensitiveColumn, redactSecrets } from '../security.mjs';

// Список намеренно узкий: слова, которые почти не встречаются как имена колонок. Основная
// защита — права agent_ro и READ ONLY транзакция; эта проверка даёт понятную ошибку заранее.
const FORBIDDEN =
  /\b(insert|update|delete|replace|merge|drop|alter|create|truncate|rename|grant|revoke|call|handler|lock|unlock|load_file|outfile|dumpfile|sleep|benchmark|get_lock|release_lock|kill|shutdown|flush|install|uninstall|prepare|execute|deallocate)\b/i;

const ALLOWED_FIRST = ['select', 'with', 'explain', 'show', 'describe', 'desc'];

/** Убирает комментарии и содержимое строковых литералов/идентификаторов в кавычках. */
export function stripSqlLiterals(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(--\s|#)[^\n]*/g, ' ')
    .replace(/'(?:''|\\.|[^'\\])*'/g, "''")
    .replace(/"(?:""|\\.|[^"\\])*"/g, "''")
    .replace(/`(?:``|[^`])*`/g, '`x`');
}

/** Возвращает нормализованный SQL или бросает ToolInputError. */
export function assertReadOnlySql(sql) {
  if (typeof sql !== 'string' || !sql.trim()) throw new ToolInputError('INVALID_SQL', 'SQL is empty.');
  if (sql.length > 10_000) throw new ToolInputError('INVALID_SQL', 'SQL is too long (max 10000 chars).');
  const trimmed = sql.trim().replace(/;\s*$/, '');
  const bare = stripSqlLiterals(trimmed);
  if (bare.includes(';')) throw new ToolInputError('MULTIPLE_STATEMENTS', 'Only a single statement is allowed.');
  const first = /^\s*\(?\s*([a-z]+)/i.exec(bare)?.[1]?.toLowerCase();
  if (!ALLOWED_FIRST.includes(first ?? '')) {
    throw new ToolInputError('NOT_READ_ONLY', 'Only SELECT / WITH / EXPLAIN / SHOW / DESCRIBE are allowed.');
  }
  const forbidden = FORBIDDEN.exec(bare);
  if (forbidden) {
    throw new ToolInputError('NOT_READ_ONLY', `Keyword "${forbidden[1]}" is not allowed in db_query.`);
  }
  if (/\bfor\s+update\b|\block\s+in\s+share\s+mode\b|\bfor\s+share\b/i.test(bare)) {
    throw new ToolInputError('NOT_READ_ONLY', 'Row-locking clauses (FOR UPDATE / LOCK IN SHARE MODE) are not allowed.');
  }
  if (/\binto\s+@/i.test(bare)) {
    throw new ToolInputError('NOT_READ_ONLY', 'SELECT … INTO variables is not allowed.');
  }
  return { sql: trimmed, kind: first };
}

function maskValue(name, v) {
  if (v === null || v === undefined) return null;
  if (isSensitiveColumn(name)) return '[REDACTED]';
  if (typeof v === 'string') return redactSecrets(v.length > 500 ? `${v.slice(0, 500)}…` : v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  if (Buffer.isBuffer(v)) return `<binary ${v.length} bytes>`;
  return v;
}

async function withReadOnlyConnection(url, maxRows, fn) {
  if (!url) {
    return {
      ok: false,
      code: 'DB_NOT_CONFIGURED',
      message: 'AGENT_DB_PASSWORD (или BTX_AGENT_DB_URL) не задан в корневом .env — read-only доступ к БД не настроен.',
    };
  }
  let conn;
  try {
    conn = await mysql.createConnection({
      uri: url,
      connectTimeout: LIMITS.dbConnectTimeoutMs,
      dateStrings: false,
      supportBigNumbers: true,
      bigNumberStrings: true,
      multipleStatements: false,
      timezone: 'Z',
    });
  } catch (err) {
    return { ok: false, code: 'DB_UNAVAILABLE', message: redactSecrets(err.message), hint: 'Запущен ли контейнер db (`docker compose up -d db`)? Совпадает ли DB_HOST_PORT?' };
  }
  try {
    await conn.query(`SET SESSION max_statement_time = ${LIMITS.dbStatementTimeoutMs / 1000}`);
    await conn.query(`SET SESSION sql_select_limit = ${maxRows + 1}`);
    await conn.query('START TRANSACTION READ ONLY');
    return await fn(conn);
  } catch (err) {
    return { ok: false, code: 'DB_ERROR', message: redactSecrets(err.message), ...(err.code ? { sqlCode: err.code } : {}) };
  } finally {
    await conn.query('ROLLBACK').catch(() => {});
    await conn.end().catch(() => {});
  }
}

export async function dbQuery(url, { sql, maxRows }) {
  const { sql: checked } = assertReadOnlySql(sql);
  return withReadOnlyConnection(url, maxRows, async (conn) => {
    const [rows, fields] = await conn.query({ sql: checked, rowsAsArray: false });
    const list = Array.isArray(rows) ? rows : [];
    const columns = (fields ?? []).map((f) => f.name);
    const out = list.slice(0, maxRows).map((r) => {
      const o = {};
      for (const c of columns) o[c] = maskValue(c, r[c]);
      return o;
    });
    return { ok: true, columns, rowCount: out.length, truncated: list.length > maxRows, rows: out };
  });
}

export async function dbSchema(url, { table }) {
  return withReadOnlyConnection(url, 10_000, async (conn) => {
    const [tables] = await conn.query(
      `SELECT TABLE_NAME AS name, TABLE_TYPE AS kind, TABLE_ROWS AS approxRows, TABLE_COMMENT AS comment
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND (? IS NULL OR TABLE_NAME = ?)
        ORDER BY TABLE_NAME`,
      [table ?? null, table ?? null],
    );
    if (!table) {
      const migrations = await conn
        .query('SELECT migration_name, finished_at FROM `_prisma_migrations` ORDER BY started_at DESC LIMIT 5')
        .then(([r]) => r.map((m) => ({ migration_name: m.migration_name, finished_at: maskValue('finished_at', m.finished_at) })))
        .catch(() => null);
      return {
        ok: true,
        tables: tables.map((t) => ({ name: t.name, kind: t.kind === 'VIEW' ? 'view' : 'table', approxRows: t.approxRows === null ? null : Number(t.approxRows), comment: t.comment || null })),
        recentMigrations: migrations,
      };
    }
    if (tables.length === 0) return { ok: false, code: 'NOT_FOUND', message: `Table "${table}" not found in the application database.` };
    const [columns] = await conn.query(
      `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE = 'YES' AS nullable, COLUMN_DEFAULT AS \`default\`, EXTRA AS extra
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [table],
    );
    const [constraints] = await conn.query(
      `SELECT tc.CONSTRAINT_NAME AS name, tc.CONSTRAINT_TYPE AS type,
              GROUP_CONCAT(k.COLUMN_NAME ORDER BY k.ORDINAL_POSITION) AS columns,
              MAX(k.REFERENCED_TABLE_NAME) AS refTable, cc.CHECK_CLAUSE AS checkClause
         FROM information_schema.TABLE_CONSTRAINTS tc
         LEFT JOIN information_schema.KEY_COLUMN_USAGE k
           ON k.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND k.TABLE_NAME = tc.TABLE_NAME AND k.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
         LEFT JOIN information_schema.CHECK_CONSTRAINTS cc
           ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.TABLE_NAME = tc.TABLE_NAME AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
        WHERE tc.TABLE_SCHEMA = DATABASE() AND tc.TABLE_NAME = ?
        GROUP BY tc.CONSTRAINT_NAME, tc.CONSTRAINT_TYPE, cc.CHECK_CLAUSE
        ORDER BY tc.CONSTRAINT_NAME`,
      [table],
    );
    const [indexes] = await conn.query(
      `SELECT INDEX_NAME AS name, NON_UNIQUE = 0 AS \`unique\`, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns
         FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
        GROUP BY INDEX_NAME, NON_UNIQUE ORDER BY INDEX_NAME`,
      [table],
    );
    return {
      ok: true,
      table,
      columns: columns.map((c) => ({ ...c, nullable: Boolean(c.nullable) })),
      constraints: constraints.map((c) => ({ name: c.name, type: c.type.toLowerCase(), columns: c.columns, ...(c.refTable ? { references: c.refTable } : {}), ...(c.checkClause ? { check: c.checkClause } : {}) })),
      indexes: indexes.map((i) => ({ ...i, unique: Boolean(i.unique) })),
    };
  });
}
