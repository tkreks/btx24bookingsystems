import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeFixtureRepo, removeFixtureRepo } from './fixture.mjs';

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/server.mjs');
let root;
let client;

beforeAll(async () => {
  root = makeFixtureRepo();
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath, root], stderr: 'ignore' }));
});
afterAll(async () => {
  await client?.close();
  removeFixtureRepo(root);
});

const parse = (res) => JSON.parse(res.content[0].text);

describe('MCP protocol', () => {
  it('exposes exactly the documented read-only tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['app_logs', 'db_query', 'db_schema', 'env_status', 'get_module_context', 'get_task_state', 'project_overview', 'read_source', 'search_code'].sort(),
    );
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });

  it('answers search_code over stdio', async () => {
    const res = parse(await client.callTool({ name: 'search_code', arguments: { kind: 'endpoint' } }));
    expect(res.ok).toBe(true);
    expect(res.total).toBe(2);
  });

  it('returns a structured error (isError) for a denied path', async () => {
    const raw = await client.callTool({ name: 'read_source', arguments: { path: '.env' } });
    expect(raw.isError).toBe(true);
    expect(parse(raw).code).toBe('PATH_DENIED');
  });

  it('rejects a write query before touching the database', async () => {
    const raw = await client.callTool({ name: 'db_query', arguments: { sql: 'DELETE FROM "Booking"' } });
    expect(parse(raw).code).toBe('NOT_READ_ONLY');
  });
});
