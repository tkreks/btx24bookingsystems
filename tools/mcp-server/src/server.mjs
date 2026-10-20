#!/usr/bin/env node
// MCP-сервер btx-dev (stdio). stdout — только протокол MCP, вся диагностика — в stderr.
// Запуск: `node tools/mcp-server/src/server.mjs [repoRoot]` (по умолчанию — cwd).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BtxCore } from './core.mjs';
import { ToolInputError } from './security.mjs';
import { TOOLS } from './tools.mjs';
import { HARD_RESPONSE_CAP_BYTES } from './config.mjs';

const root = process.argv[2] ?? process.cwd();
let core;
try {
  core = new BtxCore(root);
} catch (err) {
  process.stderr.write(`[btx-dev-mcp] failed to start: ${err.message}\n`);
  process.exit(1);
}

function textResult(payload, isError = false) {
  let text = JSON.stringify(payload);
  if (Buffer.byteLength(text) > HARD_RESPONSE_CAP_BYTES) {
    text = JSON.stringify({ ok: false, code: 'RESPONSE_TOO_LARGE', message: 'Narrow the request (smaller range/limit).' });
  }
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

const server = new McpServer({ name: 'btx-dev', version: '0.1.0' });

for (const tool of TOOLS) {
  server.registerTool(
    tool.name,
    { title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations },
    async (args) => {
      try {
        const result = await tool.run(core, args ?? {});
        return textResult(result, result?.ok === false);
      } catch (err) {
        if (err instanceof ToolInputError) return textResult({ ok: false, code: err.code, message: err.message }, true);
        process.stderr.write(`[btx-dev-mcp] ${tool.name} failed: ${err.stack ?? err.message}\n`);
        return textResult({ ok: false, code: 'INTERNAL_ERROR', message: 'Internal error — see MCP server stderr.' }, true);
      }
    },
  );
}

let closing = false;
async function shutdown(reason) {
  if (closing) return;
  closing = true;
  process.stderr.write(`[btx-dev-mcp] shutting down (${reason})\n`);
  try {
    await server.close();
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.stdin.on('close', () => shutdown('stdin closed'));

await server.connect(new StdioServerTransport());
process.stderr.write(`[btx-dev-mcp] ready at ${core.root}\n`);
