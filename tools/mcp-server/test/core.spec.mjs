import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BtxCore } from '../src/core.mjs';
import { indexFile } from '../src/repo/indexer.mjs';
import { agentDbUrl, parseDotenv } from '../src/runtime/env.mjs';
import { FIXTURE_FILES, makeFixtureRepo, removeFixtureRepo } from './fixture.mjs';

let root;
let core;
beforeAll(() => {
  root = makeFixtureRepo();
  core = new BtxCore(root);
});
afterAll(() => removeFixtureRepo(root));

describe('indexer', () => {
  it('extracts NestJS endpoints with the global /api prefix', () => {
    const { endpoints } = indexFile('a/bookings.controller.ts', FIXTURE_FILES['apps/api/src/modules/bookings/bookings.controller.ts']);
    expect(endpoints.map((e) => `${e.name} -> ${e.handler}`)).toEqual([
      'GET /api/bookings -> list',
      'POST /api/bookings/:id/cancel -> cancelBooking',
    ]);
  });

  it('extracts Prisma models and enums with line ranges', () => {
    const { symbols } = indexFile('schema.prisma', FIXTURE_FILES['apps/api/prisma/schema.prisma']);
    expect(symbols.map((s) => [s.type, s.name, s.line, s.endLine])).toEqual([
      ['model', 'Booking', 1, 3],
      ['enum', 'BookingStatus', 5, 7],
    ]);
  });
});

describe('search_code', () => {
  it('finds a symbol by Russian domain words via the glossary', () => {
    const res = core.searchCode({ query: 'пересечение брони', kind: 'symbol' });
    expect(res.results.map((r) => r.name)).toContain('BookingSlot');
  });

  it('lists all endpoints with an empty query', () => {
    const res = core.searchCode({ kind: 'endpoint' });
    expect(res.results.map((r) => r.name).sort()).toEqual(['GET /api/bookings', 'POST /api/bookings/:id/cancel']);
  });

  it('never indexes node_modules or .env files', () => {
    const res = core.searchCode({ query: 'hidden topsecret', kind: 'text' });
    expect(res.results).toEqual([]);
  });

  it('rejects an empty query for symbol search', () => {
    expect(() => core.searchCode({ query: '  ', kind: 'symbol' })).toThrow(/Empty query/);
  });

  it('sees files created after the first call', () => {
    core.searchCode({ query: 'booking' });
    fs.writeFileSync(path.join(root, 'apps/api/src/modules/bookings/slots.ts'), 'export class SlotFinder {}\n');
    expect(core.searchCode({ query: 'SlotFinder' }).results[0]?.name).toBe('SlotFinder');
  });
});

describe('read_source', () => {
  it('reads a symbol by symbol_id and redacts secrets in the fragment', () => {
    const hit = core.searchCode({ query: 'assertNoOverlap' }).results[0];
    const res = core.readSource({ symbol_id: hit.symbol_id });
    expect(res.ok).toBe(true);
    expect(res.content).toContain('function assertNoOverlap');
    expect(res.content).not.toContain('supersecret');
    expect(res.redacted).toBe(true);
  });

  it('detects a stale expected_hash', () => {
    const res = core.readSource({ path: 'AGENTS.md', start_line: 1, end_line: 2, expected_hash: 'deadbeef' });
    expect(res).toMatchObject({ ok: false, code: 'STALE_REFERENCE' });
  });

  it('refuses .env', () => {
    expect(() => core.readSource({ path: '.env' })).toThrow(/denied/);
  });
});

describe('module context, task state, overview', () => {
  it('returns MODULE.md, endpoints and tests for a module', () => {
    const res = core.getModuleContext({ module: 'bookings' });
    expect(res.moduleDoc).toContain('no overlapping bookings');
    expect(res.endpoints).toHaveLength(2);
    expect(res.tests).toEqual(['apps/api/src/modules/bookings/bookings.service.spec.ts']);
  });

  it('reads a checkpoint and rejects path-like task ids', () => {
    expect(core.getTaskState({ task_id: 'T-1' }).content).toContain('Goal: test');
    expect(() => core.getTaskState({ task_id: '../../etc/passwd' })).toThrow(/task_id/);
  });

  it('overview lists workspaces and modules without leaking .env values', () => {
    const res = core.projectOverview();
    expect(res.workspaces).toEqual([{ name: '@fx/api', path: 'apps/api' }]);
    expect(res.modules.find((m) => m.name === 'bookings')?.hasModuleDoc).toBe(true);
    expect(JSON.stringify(res)).not.toContain('topsecret');
  });
});

describe('runtime env', () => {
  it('parses dotenv and builds the agent_ro URL', () => {
    const env = parseDotenv('# c\nAGENT_DB_PASSWORD="p@ss word"\nDB_HOST_PORT=6000 # port\n');
    expect(agentDbUrl(env)).toBe('postgresql://agent_ro:p%40ss%20word@127.0.0.1:6000/btx24');
  });

  it('db tools report DB_NOT_CONFIGURED instead of throwing when no password is set', async () => {
    const bare = makeFixtureRepo();
    fs.rmSync(path.join(bare, '.env'));
    const res = await new BtxCore(bare).dbSchema({});
    removeFixtureRepo(bare);
    expect(res).toMatchObject({ ok: false, code: 'DB_NOT_CONFIGURED' });
  });
});
