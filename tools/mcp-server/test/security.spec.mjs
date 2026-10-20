import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redactSecrets, resolveInRepo, isSensitiveColumn } from '../src/security.mjs';
import { makeFixtureRepo, removeFixtureRepo } from './fixture.mjs';

let root;
beforeAll(() => {
  root = makeFixtureRepo();
});
afterAll(() => removeFixtureRepo(root));

const codeOf = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.code;
  }
  return 'NO_ERROR';
};

describe('resolveInRepo', () => {
  it('resolves a normal repo-relative file', () => {
    expect(resolveInRepo(root, 'AGENTS.md').rel).toBe('AGENTS.md');
  });

  it.each([
    ['../etc/passwd', 'PATH_OUTSIDE_REPO'],
    ['apps/../../x', 'PATH_OUTSIDE_REPO'],
    ['/etc/passwd', 'PATH_OUTSIDE_REPO'],
    ['.env', 'PATH_DENIED'],
    ['apps/api/.env', 'PATH_DENIED'],
    ['node_modules/x/index.js', 'PATH_DENIED'],
    ['.git/config', 'PATH_DENIED'],
    ['certs/server.key', 'PATH_DENIED'],
    ['missing.md', 'NOT_FOUND'],
  ])('rejects %s with %s', (p, code) => {
    expect(codeOf(() => resolveInRepo(root, p))).toBe(code);
  });

  it('rejects a symlink pointing outside the repository', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'btx-outside-'));
    fs.writeFileSync(path.join(outside, 'outside.txt'), 'nope');
    fs.symlinkSync(outside, path.join(root, 'docs', 'link'));
    expect(codeOf(() => resolveInRepo(root, 'docs/link/outside.txt'))).toBe('PATH_OUTSIDE_REPO');
    fs.rmSync(outside, { recursive: true, force: true });
  });
});

describe('redactSecrets', () => {
  it.each([
    ['postgresql://app:supersecret@db:5432/app', 'supersecret'],
    ['DB_PASSWORD=hunter2hunter2', 'hunter2hunter2'],
    ['"client_secret": "abcdef123456"', 'abcdef123456'],
    ['AUTH_ID=8f3a2b1c9d8e7f6a5b4c', '8f3a2b1c9d8e7f6a5b4c'],
    ['Authorization: Bearer abc.def.ghi', 'abc.def.ghi'],
    ['https://portal.bitrix24.ru/rest/1/q1w2e3r4t5y6u7i8/profile', 'q1w2e3r4t5y6u7i8'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJlMTIz', 'eyJhbGciOiJIUzI1NiJ9'],
  ])('hides the secret in %s', (input, secret) => {
    const out = redactSecrets(input);
    expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED]');
  });

  it('leaves ordinary code alone', () => {
    const code = 'const tokenize = (s) => s.split(" ");\nexport function bookSlot() {}';
    expect(redactSecrets(code)).toBe(code);
  });
});

describe('isSensitiveColumn', () => {
  it('flags token-like columns only', () => {
    expect(isSensitiveColumn('accessToken')).toBe(true);
    expect(isSensitiveColumn('refresh_token')).toBe(true);
    expect(isSensitiveColumn('startsAt')).toBe(false);
  });
});
