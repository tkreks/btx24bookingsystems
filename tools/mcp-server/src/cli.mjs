#!/usr/bin/env node
// CLI-доступ к тем же инструментам, что и MCP — для людей и как fallback, если MCP недоступен.
//   npm run mcp:cli -- list
//   npm run mcp:cli -- search_code '{"query":"health","kind":"endpoint"}'
//   npm run mcp:cli -- db_query '{"sql":"SELECT 1"}'
import { z } from 'zod';
import { BtxCore } from './core.mjs';
import { ToolInputError } from './security.mjs';
import { TOOLS, findTool } from './tools.mjs';

const [name, rawArgs] = process.argv.slice(2);

if (!name || name === 'list' || name === '--help') {
  for (const t of TOOLS) console.log(`${t.name.padEnd(20)} ${t.title}`);
  process.exit(0);
}

const tool = findTool(name);
if (!tool) {
  console.error(`Unknown tool "${name}". Run with "list" to see tools.`);
  process.exit(2);
}

try {
  const args = z.object(tool.inputSchema).strict().parse(rawArgs ? JSON.parse(rawArgs) : {});
  const result = await tool.run(new BtxCore(process.env.BTX_REPO_ROOT ?? process.cwd()), args);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result?.ok === false ? 1 : 0);
} catch (err) {
  if (err instanceof ToolInputError) console.error(`${err.code}: ${err.message}`);
  else if (err instanceof z.ZodError) console.error(`Invalid arguments: ${err.message}`);
  else console.error(err.stack ?? err.message);
  process.exit(2);
}
