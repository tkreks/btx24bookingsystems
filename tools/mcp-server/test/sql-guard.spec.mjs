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

describe('assertReadOnlySql (MariaDB)', () => {
  it.each([
    'SELECT 1',
    "select * from `Portal` where status = 'ACTIVE';",
    'WITH x AS (SELECT 1) SELECT * FROM x',
    'EXPLAIN SELECT * FROM `Portal`',
    "SELECT 'drop table x; delete' AS s",
    'SELECT `update` FROM t',
    'SELECT startsAt, comment FROM t -- trailing comment',
    'SHOW TABLES',
    'DESCRIBE `Portal`',
  ])('allows %s', (sql) => {
    expect(codeOf(sql)).toBe('OK');
  });

  it.each([
    ['DELETE FROM `Portal`', 'NOT_READ_ONLY'],
    ['UPDATE t SET a = 1', 'NOT_READ_ONLY'],
    ['REPLACE INTO t VALUES (1)', 'NOT_READ_ONLY'],
    ['SELECT 1; DROP TABLE t', 'MULTIPLE_STATEMENTS'],
    ['SELECT * FROM t FOR UPDATE', 'NOT_READ_ONLY'],
    ['SELECT * FROM t LOCK IN SHARE MODE', 'NOT_READ_ONLY'],
    ["SELECT LOAD_FILE('/etc/passwd')", 'NOT_READ_ONLY'],
    ["SELECT * FROM t INTO OUTFILE '/tmp/x'", 'NOT_READ_ONLY'],
    ['SELECT SLEEP(100)', 'NOT_READ_ONLY'],
    ['SELECT 1 INTO @x', 'NOT_READ_ONLY'],
    ['CREATE TABLE x (id int)', 'NOT_READ_ONLY'],
    ['/* hi */ INSERT INTO t VALUES (1)', 'NOT_READ_ONLY'],
    ['SET autocommit = 1', 'NOT_READ_ONLY'],
    ['', 'INVALID_SQL'],
  ])('rejects %s', (sql, code) => {
    expect(codeOf(sql)).toBe(code);
  });
});
