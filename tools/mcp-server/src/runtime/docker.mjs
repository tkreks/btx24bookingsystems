// Read-only обёртки над `docker compose`: только ps / logs / config --services.
// Аргументы фиксированы, без shell; имя сервиса проверяется по списку из compose-файла.
import { execFile } from 'node:child_process';
import { LIMITS } from '../config.mjs';
import { ToolInputError, redactSecrets } from '../security.mjs';

function run(root, args, { timeoutMs = LIMITS.commandTimeoutMs } = {}) {
  return new Promise((resolve) => {
    execFile('docker', ['compose', ...args], { cwd: root, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

function dockerError(res) {
  const msg = res.stderr.trim() || `docker exited with ${res.code}`;
  let hint;
  if (/permission denied/i.test(msg)) hint = 'Текущий пользователь не в группе docker (см. docs/agents/MCP_SERVER.md → «Доступ к Docker»).';
  else if (res.code === 'ENOENT') hint = 'docker CLI не найден в PATH.';
  else if (/no configuration file/i.test(msg)) hint = 'docker-compose.yml не найден в корне репозитория.';
  return { ok: false, code: 'DOCKER_UNAVAILABLE', message: redactSecrets(msg.slice(0, 500)), ...(hint ? { hint } : {}) };
}

export async function composeServices(root) {
  const res = await run(root, ['config', '--services']);
  if (!res.ok) return dockerError(res);
  return { ok: true, services: res.stdout.split('\n').map((s) => s.trim()).filter(Boolean) };
}

export async function composePs(root) {
  const res = await run(root, ['ps', '--all', '--format', 'json']);
  if (!res.ok) return dockerError(res);
  const text = res.stdout.trim();
  let rows = [];
  if (text.startsWith('[')) rows = JSON.parse(text);
  else if (text) rows = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return {
    ok: true,
    containers: rows.map((r) => ({
      service: r.Service,
      name: r.Name,
      state: r.State,
      health: r.Health || null,
      status: r.Status,
      ports: r.Publishers?.filter((p) => p.PublishedPort).map((p) => `${p.URL}:${p.PublishedPort}->${p.TargetPort}/${p.Protocol}`) ?? r.Ports,
    })),
  };
}

export async function composeLogs(root, { service, tail, since, grep }) {
  const services = await composeServices(root);
  if (!services.ok) return services;
  if (!services.services.includes(service)) {
    throw new ToolInputError('UNKNOWN_SERVICE', `Unknown service "${service}". Known: ${services.services.join(', ')}`);
  }
  if (since !== undefined && !/^\d+[smhd]$/.test(since)) {
    throw new ToolInputError('INVALID_SINCE', 'since must look like 30s, 15m, 2h or 1d.');
  }
  const args = ['logs', '--no-color', '--timestamps', '--tail', String(tail)];
  if (since) args.push('--since', since);
  args.push(service);
  const res = await run(root, args);
  if (!res.ok) return dockerError(res);
  let lines = (res.stdout + res.stderr).split('\n').filter(Boolean);
  if (grep) {
    const needle = grep.toLowerCase();
    lines = lines.filter((l) => l.toLowerCase().includes(needle));
  }
  return { ok: true, service, lineCount: lines.length, lines: lines.map((l) => redactSecrets(l).slice(0, 1000)) };
}
