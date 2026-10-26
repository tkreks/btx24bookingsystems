import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { Instance } from './instance.js';
import { FIRST_DISPLAY, Manager } from './manager.js';
import { createMessengerServer } from './server.js';
import { normalizePhone, type InstanceSpec, type InstanceStatus } from './spec.js';

/** Экземпляр без браузера: запоминает, что с ним делали. */
function fakeInstance(spec: InstanceSpec) {
  const info: InstanceStatus = { id: spec.id, kind: spec.kind, phone: spec.phone, auth: spec.auth, state: 'stopped', code: null, qr: null, account: null, error: null, updatedAt: '' };
  return {
    spec,
    get info() {
      return info;
    },
    start: vi.fn(async () => void (info.state = 'pairing')),
    stop: vi.fn(async () => void (info.state = 'stopped')),
    logout: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => null),
    contact: vi.fn(async () => ({ exists: true, chatId: '79259734763@c.us' })),
    avatar: vi.fn(async (chat: string) => (chat === '1@lid' ? { fileId: 'a'.repeat(40), mime: 'image/jpeg', name: 'avatar.jpg', size: 3 } : null)),
  } as unknown as Instance;
}

async function setup(token = '') {
  const dataDir = await mkdtemp(`${tmpdir()}/messenger-`);
  const manager = new Manager({ dataDir, chromium: '', display: false }, fakeInstance);
  await manager.boot();
  const server = createMessengerServer(manager, token);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { manager, dataDir, base, close: () => new Promise((r) => server.close(r)) };
}

describe('Сервис мессенджеров', () => {
  it('номер телефона — только цифры с кодом страны', () => {
    expect(normalizePhone('+7 (999) 123-45-67')).toBe('79991234567');
    expect(normalizePhone('8 999 123 45 67')).toBe('79991234567');
    expect(normalizePhone('9991234567')).toBe('79991234567');
    expect(normalizePhone('123')).toBeNull();
  });

  it('создание — идемпотентно, экраны не пересекаются, реестр переживает перезапуск', async () => {
    const t = await setup();
    const put = (id: string, phone: string) => fetch(`${t.base}/instances/${id}`, { method: 'PUT', body: JSON.stringify({ kind: 'whatsapp', phone }) }).then((r) => r.json());
    expect(await put('aaaaaaaa1', '+79991234567')).toMatchObject({ id: 'aaaaaaaa1', phone: '79991234567', auth: 'code' });
    await put('aaaaaaaa1', '+79991234567');
    await put('bbbbbbbb2', '79990000000');
    expect(t.manager.list()).toHaveLength(2);
    const specs = JSON.parse(await readFile(`${t.dataDir}/instances.json`, 'utf8')) as InstanceSpec[];
    expect(specs.map((s) => s.display)).toEqual([FIRST_DISPLAY, FIRST_DISPLAY + 1]);
    await t.close();
  });

  it('аватар собеседника: маршрут, проверка ID чата, нет фото — media: null', async () => {
    const t = await setup();
    await fetch(`${t.base}/instances/aaaaaaaa1`, { method: 'PUT', body: JSON.stringify({ kind: 'whatsapp', phone: '79991234567' }) });
    const post = (chat: unknown) => fetch(`${t.base}/instances/aaaaaaaa1/avatar`, { method: 'POST', body: JSON.stringify({ chat }) });
    expect(await (await post('1@lid')).json()).toEqual({ media: { fileId: 'a'.repeat(40), mime: 'image/jpeg', name: 'avatar.jpg', size: 3 } });
    expect(await (await post('2@c.us')).json()).toEqual({ media: null });
    expect((await post('../x')).status).toBe(400);
    await t.close();
  });

  it('проверка номера read-only, с токеном; несуществующий экземпляр отличается от отрицательного результата', async () => {
    const t = await setup('secret'); const headers = { 'x-messenger-token': 'secret' };
    try {
      expect((await fetch(`${t.base}/instances/aaaaaaaa1/contact`, { method:'POST',body:JSON.stringify({phone:'79259734763'}) })).status).toBe(401);
      expect((await fetch(`${t.base}/instances/aaaaaaaa1/contact`, { method:'POST',headers,body:JSON.stringify({phone:'79259734763'}) })).status).toBe(404);
      await fetch(`${t.base}/instances/aaaaaaaa1`, { method:'PUT',headers,body:JSON.stringify({kind:'whatsapp',phone:'74993467272'}) });
      const res=await fetch(`${t.base}/instances/aaaaaaaa1/contact`, { method:'POST',headers,body:JSON.stringify({phone:'79259734763'}) });
      expect(await res.json()).toEqual({exists:true,chatId:'79259734763@c.us'});
      expect((await fetch(`${t.base}/instances/aaaaaaaa1/contact`, { method:'POST',headers,body:JSON.stringify({phone:'bad'}) })).status).toBe(400);
      expect(t.manager.list()).toHaveLength(1);
    } finally { await t.close(); }
  });

  it('без токена — 401; неверные данные — 400; удаление убирает экземпляр', async () => {
    const t = await setup('secret');
    expect((await fetch(`${t.base}/instances`)).status).toBe(401);
    const h = { 'x-messenger-token': 'secret' };
    expect((await fetch(`${t.base}/instances/aaaaaaaa1`, { method: 'PUT', headers: h, body: JSON.stringify({ kind: 'icq', phone: '1' }) })).status).toBe(400);
    await fetch(`${t.base}/instances/aaaaaaaa1`, { method: 'PUT', headers: h, body: JSON.stringify({ kind: 'whatsapp', phone: '79991234567' }) });
    await fetch(`${t.base}/instances/aaaaaaaa1`, { method: 'DELETE', headers: h });
    expect(await (await fetch(`${t.base}/instances`, { headers: h })).json()).toEqual([]);
    await t.close();
  });
});

describe('Доставка событий в api', () => {
  it('не принял — повтор; принял — очередь пуста', async () => {
    const { Outbox } = await import('./messages.js');
    let calls = 0;
    const send = vi.fn(async () => ({ ok: ++calls > 1 }) as Response);
    const box = new Outbox('http://api/hook', '', () => undefined, send as unknown as typeof fetch);
    vi.useFakeTimers();
    box.push({ type: 'ack', instanceId: 'x', id: 'm', ack: 2 });
    await vi.advanceTimersByTimeAsync(1500);
    vi.useRealTimers();
    expect(send).toHaveBeenCalledTimes(2);
    expect(box.size).toBe(0);
  });
});

describe('ID WhatsApp в разных форматах', () => {
  it('строка, _serialized, user@server и ключ сообщения', async () => {
    const { widOf } = await import('./messages.js');
    expect(widOf('79991234567@c.us')).toBe('79991234567@c.us');
    expect(widOf({ _serialized: '224313525416001@lid' })).toBe('224313525416001@lid');
    expect(widOf({ user: '224313525416001', server: 'lid' })).toBe('224313525416001@lid');
    expect(widOf({ fromMe: true, remote: { user: '224313525416001', server: 'lid' }, id: '3EB0ABC' })).toBe('true_224313525416001@lid_3EB0ABC');
    expect(widOf(undefined)).toBe('');
  });
});

describe('реакции WhatsApp', () => {
  it('по одной на поставившего; своя — mine', async () => {
    const { waReactions } = await import('./messages.js');
    expect(waReactions([{ id: '👍', aggregateEmoji: '👍', senders: [{ reaction: '👍', id: { fromMe: true } }, { reaction: '👍', id: { fromMe: false } }] }, { id: '❤️', senders: [{ reaction: '', id: {} }] }])).toEqual([
      { emoji: '👍', mine: true },
      { emoji: '👍', mine: false },
      { emoji: '❤️', mine: false },
    ]);
    expect(waReactions(null)).toEqual([]);
  });
});
