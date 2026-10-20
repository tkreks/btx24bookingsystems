import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('HeartbeatService', () => {
  it('writes a fresh timestamp and stops on shutdown', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'hb-')), 'beat');
    process.env.WORKER_HEARTBEAT_FILE = file;
    vi.resetModules();
    const { HeartbeatService } = await import('./heartbeat.service.js');
    const svc = new HeartbeatService();
    svc.onModuleInit();
    expect(Date.now() - Number(readFileSync(file, 'utf8'))).toBeLessThan(1000);
    svc.onApplicationShutdown();
    delete process.env.WORKER_HEARTBEAT_FILE;
  });
});
