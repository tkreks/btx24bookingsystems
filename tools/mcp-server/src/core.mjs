// BtxCore — единое ядро, которое обслуживают и MCP-сервер (server.mjs), и CLI (cli.mjs).
// Вся логика инструментов здесь; адаптеры только разбирают аргументы и печатают результат.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { LIMITS, MODULE_ROOTS, RESPONSE_BUDGET_BYTES, STANDALONE_MODULES } from './config.mjs';
import { fitBudget } from './budget.mjs';
import { ToolInputError, redactSecrets, resolveInRepo } from './security.mjs';
import { RepoIndex, parseSymbolId, symbolId } from './repo/indexer.mjs';
import { search } from './repo/search.mjs';
import { agentDbUrl, appBaseUrl, loadRuntimeEnv } from './runtime/env.mjs';
import { composeLogs, composePs } from './runtime/docker.mjs';
import { dbQuery, dbSchema } from './runtime/db.mjs';

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

const KEY_DOCS = [
  'AGENTS.md',
  'CONTRIBUTING.md',
  'docs/agents/WORKFLOW.md',
  'docs/agents/MCP_SERVER.md',
  'docs/agents/TASK_TEMPLATE.md',
  'docs/bitrix24/README.md',
  'docs/decisions',
];

export class BtxCore {
  constructor(root) {
    const abs = path.resolve(root);
    if (!fs.existsSync(path.join(abs, 'package.json'))) {
      throw new Error(`Not a repository root (no package.json): ${abs}`);
    }
    this.root = abs;
    this.index = new RepoIndex(abs);
  }

  #git(args) {
    try {
      return execFileSync('git', args, { cwd: this.root, timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  }

  #listModules() {
    const modules = [];
    for (const { prefix, kind } of MODULE_ROOTS) {
      const dir = path.join(this.root, prefix);
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        modules.push({ name: e.name, kind, path: `${prefix}${e.name}`, hasModuleDoc: fs.existsSync(path.join(dir, e.name, 'MODULE.md')) });
      }
    }
    for (const [name, rel] of Object.entries(STANDALONE_MODULES)) {
      if (fs.existsSync(path.join(this.root, rel))) {
        modules.push({ name, kind: 'standalone', path: rel, hasModuleDoc: fs.existsSync(path.join(this.root, rel, 'MODULE.md')) });
      }
    }
    return modules;
  }

  projectOverview() {
    this.index.refresh();
    const pkg = JSON.parse(fs.readFileSync(path.join(this.root, 'package.json'), 'utf8'));
    const workspaces = [];
    for (const pattern of pkg.workspaces ?? []) {
      const base = pattern.replace(/\/\*$/, '');
      let dirs = [];
      try {
        dirs = fs.readdirSync(path.join(this.root, base), { withFileTypes: true }).filter((d) => d.isDirectory());
      } catch {
        continue;
      }
      for (const d of dirs) {
        const p = path.join(this.root, base, d.name, 'package.json');
        if (fs.existsSync(p)) workspaces.push({ name: JSON.parse(fs.readFileSync(p, 'utf8')).name, path: `${base}/${d.name}` });
      }
    }
    const status = this.#git(['status', '--porcelain']);
    return fitBudget(
      {
        ok: true,
        project: pkg.name,
        root: this.root,
        git: { branch: this.#git(['rev-parse', '--abbrev-ref', 'HEAD']), head: this.#git(['rev-parse', '--short', 'HEAD']), changedFiles: status === null ? null : status.split('\n').filter(Boolean).length },
        workspaces,
        modules: this.#listModules(),
        keyDocs: KEY_DOCS.filter((d) => fs.existsSync(path.join(this.root, d))),
        index: { files: this.index.files.size, symbols: this.index.allSymbols().length, refreshedAt: this.index.refreshedAt },
        scripts: Object.keys(pkg.scripts ?? {}),
        hint: 'Правила — AGENTS.md. Для незнакомой задачи: search_code → read_source → get_module_context. Runtime: env_status, app_logs, db_schema, db_query.',
      },
      RESPONSE_BUDGET_BYTES.overview,
    );
  }

  searchCode({ query = '', kind, scope, limit }) {
    if (query.length > LIMITS.maxQueryLength) throw new ToolInputError('QUERY_TOO_LONG', `Query longer than ${LIMITS.maxQueryLength} chars.`);
    if (!query.trim() && kind !== 'endpoint' && kind !== 'prisma') {
      throw new ToolInputError('EMPTY_QUERY', 'Empty query is only allowed with kind "endpoint" or "prisma" (lists everything).');
    }
    const max = Math.min(limit ?? LIMITS.searchDefaultLimit, LIMITS.searchMaxLimit);
    this.index.refresh();
    const res = search(this.index, { query, kind, scope, limit: max });
    return fitBudget({ ok: true, query, kind: kind ?? 'any', ...(scope ? { scope } : {}), ...res, indexedAt: this.index.refreshedAt }, RESPONSE_BUDGET_BYTES.search);
  }

  readSource({ path: userPath, start_line, end_line, symbol_id, expected_hash }) {
    let relPath = userPath;
    let start = start_line;
    let end = end_line;
    if (symbol_id) {
      const parsed = parseSymbolId(symbol_id);
      if (!parsed) throw new ToolInputError('INVALID_SYMBOL_ID', 'symbol_id must look like "<path>#<name>@<line>" (take it from search_code).');
      this.index.refresh();
      const sym = this.index.allSymbols().find((s) => symbolId(s) === symbol_id);
      if (!sym) {
        const candidates = this.index.allSymbols().filter((s) => s.path === parsed.path && s.name === parsed.name);
        return { ok: false, code: 'STALE_REFERENCE', message: 'Symbol moved or disappeared; re-run search_code.', candidates: candidates.map(symbolId).slice(0, 5) };
      }
      relPath = sym.path;
      start ??= sym.line;
      end ??= sym.endLine;
    }
    if (!relPath) throw new ToolInputError('INVALID_ARGS', 'Pass either symbol_id or path.');
    const { abs, rel } = resolveInRepo(this.root, relPath);
    const st = fs.statSync(abs);
    if (!st.isFile()) throw new ToolInputError('NOT_A_FILE', `${rel} is not a file.`);
    if (st.size > LIMITS.maxFileBytesToScan * 2) throw new ToolInputError('FILE_TOO_LARGE', `${rel} is too large to read.`);
    const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
    start = Math.max(1, start ?? 1);
    end = Math.min(lines.length, end ?? start + LIMITS.sourceMaxLines - 1);
    if (end < start) throw new ToolInputError('INVALID_RANGE', 'end_line is before start_line.');
    const capped = end - start + 1 > LIMITS.sourceMaxLines;
    if (capped) end = start + LIMITS.sourceMaxLines - 1;
    const fragment = lines.slice(start - 1, end).join('\n');
    const hash = sha(fragment);
    if (expected_hash && expected_hash !== hash) {
      return { ok: false, code: 'STALE_REFERENCE', message: 'Fragment changed since expected_hash was taken.', path: rel, start_line: start, end_line: end, hash };
    }
    const content = redactSecrets(fragment);
    return fitBudget(
      { ok: true, path: rel, start_line: start, end_line: end, total_lines: lines.length, hash, ...(capped ? { capped: true, hint: `Max ${LIMITS.sourceMaxLines} lines per call — request the next range.` } : {}), ...(content !== fragment ? { redacted: true } : {}), content },
      RESPONSE_BUDGET_BYTES.source,
    );
  }

  getModuleContext({ module }) {
    const mod = this.#listModules().find((m) => m.name === module || m.path === module);
    if (!mod) {
      throw new ToolInputError('UNKNOWN_MODULE', `Unknown module "${module}". Known: ${this.#listModules().map((m) => m.name).join(', ') || '(none yet)'}`);
    }
    this.index.refresh();
    const prefix = `${mod.path}/`;
    const files = [...this.index.files.keys()].filter((f) => f.startsWith(prefix));
    let moduleDoc = null;
    const docPath = path.join(this.root, mod.path, 'MODULE.md');
    if (fs.existsSync(docPath)) moduleDoc = redactSecrets(fs.readFileSync(docPath, 'utf8'));
    const symbols = this.index.allSymbols().filter((s) => s.path.startsWith(prefix) && (s.exported || s.kind === 'endpoint' || s.kind === 'prisma'));
    return fitBudget(
      {
        ok: true,
        module: mod.name,
        kind: mod.kind,
        path: mod.path,
        moduleDoc,
        endpoints: symbols.filter((s) => s.kind === 'endpoint').map((s) => ({ name: s.name, handler: s.handler, symbol_id: symbolId(s) })),
        symbols: symbols.filter((s) => s.kind !== 'endpoint' && s.kind !== 'docs').map((s) => ({ type: s.type, name: s.name, symbol_id: symbolId(s) })),
        tests: files.filter((f) => /\.(spec|test)\.[mc]?[tj]sx?$/.test(f)),
        files: files.filter((f) => !/\.(spec|test)\./.test(f)),
      },
      RESPONSE_BUDGET_BYTES.module,
    );
  }

  getTaskState({ task_id }) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(task_id) || task_id.startsWith('.')) {
      throw new ToolInputError('INVALID_TASK_ID', 'task_id may contain only letters, digits, ".", "_" and "-".');
    }
    const p = path.join(this.root, '.agent', 'tasks', `${task_id}.md`);
    if (!fs.existsSync(p)) return { ok: false, code: 'NOT_FOUND', message: `No checkpoint .agent/tasks/${task_id}.md` };
    const st = fs.statSync(p);
    return fitBudget(
      { ok: true, task_id, updatedAt: st.mtime.toISOString(), note: 'Checkpoint is a hint, not a source of truth — re-check git diff and files.', content: redactSecrets(fs.readFileSync(p, 'utf8')) },
      RESPONSE_BUDGET_BYTES.task_state,
    );
  }

  async envStatus() {
    const env = loadRuntimeEnv(this.root);
    const [containers, health] = await Promise.all([composePs(this.root), this.#appHealth(env)]);
    return fitBudget(
      {
        ok: true,
        containers,
        app: health,
        db: { readOnlyAccessConfigured: Boolean(agentDbUrl(env)), hostPort: env.DB_HOST_PORT ?? '55432' },
      },
      RESPONSE_BUDGET_BYTES.runtime,
    );
  }

  async #appHealth(env) {
    const url = `${appBaseUrl(env)}/api/health`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(LIMITS.httpTimeoutMs) });
      const body = await res.text();
      let json = null;
      try {
        json = JSON.parse(body);
      } catch {
        // не JSON — вернём кусок текста
      }
      return { reachable: true, url, httpStatus: res.status, body: json ?? redactSecrets(body.slice(0, 300)) };
    } catch (err) {
      return { reachable: false, url, error: err.name === 'TimeoutError' ? 'timeout' : err.message };
    }
  }

  async appLogs({ service = 'app', tail, since, grep }) {
    const n = Math.min(tail ?? LIMITS.logsDefaultTail, LIMITS.logsMaxTail);
    const res = await composeLogs(this.root, { service, tail: n, since, grep });
    return fitBudget(res, RESPONSE_BUDGET_BYTES.runtime);
  }

  async dbSchema({ table }) {
    if (table !== undefined && !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(table)) {
      throw new ToolInputError('INVALID_TABLE', 'table must be a plain identifier.');
    }
    return fitBudget(await dbSchema(agentDbUrl(loadRuntimeEnv(this.root)), { table }), RESPONSE_BUDGET_BYTES.db);
  }

  async dbQuery({ sql, max_rows }) {
    const maxRows = Math.min(max_rows ?? LIMITS.dbDefaultRows, LIMITS.dbMaxRows);
    return fitBudget(await dbQuery(agentDbUrl(loadRuntimeEnv(this.root)), { sql, maxRows }), RESPONSE_BUDGET_BYTES.db);
  }
}
