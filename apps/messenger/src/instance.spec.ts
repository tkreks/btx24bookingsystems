import type { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Instance, READY_TIMEOUT_MS } from './instance.js';

// Свой каталог на прогон: общий /tmp/wa-test мог остаться от другого пользователя без прав.
const dataDir = mkdtempSync(join(tmpdir(), 'wa-test-'));

/** Клиент whatsapp-web.js без браузера: события подаёт тест. */
const clients = vi.hoisted(() => [] as (EventEmitter & { destroy: ReturnType<typeof vi.fn> })[]);
vi.mock('whatsapp-web.js', async () => {
  const { EventEmitter } = await import('node:events');
  class Client extends EventEmitter {
    info = { wid: { _serialized: '74993257916@c.us' } };
    destroy = vi.fn(async () => undefined);
    initialize = vi.fn(async () => undefined);
    constructor() {
      super();
      clients.push(this);
    }
  }
  return { default: { Client, LocalAuth: class {}, MessageMedia: class {} } };
});

const spec = { id: 'wa1', kind: 'whatsapp' as const, phone: '74993257916', auth: 'qr' as const, display: 100 };

describe('WhatsApp: вход без «готов»', () => {
  beforeEach(() => {
    clients.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('перезапускает клиент, если после входа «готов» не наступил', async () => {
    const inst = new Instance(spec, { dataDir, chromium: '', display: false }, () => undefined);
    await inst.start();
    clients[0].emit('authenticated');
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS + 10);
    expect(clients[0].destroy).toHaveBeenCalled();
    await vi.waitFor(() => expect(clients).toHaveLength(2));
    clients[1].emit('authenticated');
    clients[1].emit('ready');
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS + 10);
    expect(clients).toHaveLength(2);
    expect(inst.info).toMatchObject({ state: 'ready', account: '74993257916@c.us' });
  });

  it('после нескольких перезапусков подряд — «не удалось», без бесконечного круга', async () => {
    const inst = new Instance(spec, { dataDir, chromium: '', display: false }, () => undefined);
    await inst.start();
    for (let i = 0; i < 4; i++) {
      await vi.waitFor(() => expect(clients).toHaveLength(i + 1));
      clients[i].emit('authenticated');
      await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS + 10);
    }
    await vi.waitFor(() => expect(inst.info.state).toBe('failed'));
    expect(clients).toHaveLength(4);
  });
});
