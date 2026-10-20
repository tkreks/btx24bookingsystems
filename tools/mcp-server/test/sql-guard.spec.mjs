import { describe, expect, it } from 'vitest';
import { assertReadOnlySql } from '../src/runtime/db.mjs';

const codeOf = (sql) => {
  try {
    assertReadOnlySql(sql);
    return 'OK';
  } catch (e) {
    return e.code;
  }
};

describe('assertReadOnlySql', () => {
  it.each([
    'SELECT 1',
    'select * from "Booking" where status = \'CONFIRMED\';',
    'WITH x AS (SELECT 1) SELECT * FROM x',
    'EXPLAIN SELECT * FROM "Booking"',
    'EXPLAIN (ANALYZE, BUFFERS) SELECT 1',
    "SELECT 'drop table x; delete' AS s",
    'SELECT "update" FROM t',
    'SELECT starts_at, comment FROM t',
    'SHOW timezone',
  ])('allows %s', (sql) => {
    expect(codeOf(sql)).toBe('OK');
  });

  it.each([
    ['DELETE FROM "Booking"', 'NOT_READ_ONLY'],
    ['UPDATE t SET a = 1', 'NOT_READ_ONLY'],
    ['SELECT 1; DROP TABLE t', 'MULTIPLE_STATEMENTS'],
    ['WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d', 'NOT_READ_ONLY'],
    ['SELECT * FROM t FOR UPDATE', 'NOT_READ_ONLY'],
    ["SELECT pg_read_file('/etc/passwd')", 'NOT_READ_ONLY'],
    ['SELECT pg_terminate_backend(1)', 'NOT_READ_ONLY'],
    ['CREATE TABLE x (id int)', 'NOT_READ_ONLY'],
    ['/* hi */ INSERT INTO t VALUES (1)', 'NOT_READ_ONLY'],
    ['', 'INVALID_SQL'],
  ])('rejects %s', (sql, code) => {
    expect(codeOf(sql)).toBe(code);
  });
});
