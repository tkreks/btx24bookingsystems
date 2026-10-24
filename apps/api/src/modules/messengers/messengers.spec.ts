import type { PrismaService } from '../../prisma/prisma.service.js';
import type { MessengerServiceClient } from './messenger-service.client.js';
import { MessengersService } from './messengers.service.js';
import { VncTickets, VNC_TICKET_TTL_MS } from './vnc-tickets.js';

function setup() {
  const rows: Record<string, unknown>[] = [];
  const prisma = {
    messenger: {
      findMany: vi.fn(async ({ where }: { where: { portalId: string } }) => rows.filter((r) => r.portalId === where.portalId)),
      findUnique: vi.fn(async ({ where }: { where: { portalId_kind_phone: { portalId: string; phone: string } } }) =>
        rows.find((r) => r.portalId === where.portalId_kind_phone.portalId && r.phone === where.portalId_kind_phone.phone) ?? null),
      findFirst: vi.fn(async ({ where }: { where: { id: string; portalId: string } }) => rows.find((r) => r.id === where.id && r.portalId === where.portalId) ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `m${rows.length + 1}xxxxxxxx`, state: 'starting', account: null, lastError: null, connectedAt: null, createdAt: new Date(), title: null, ...data };
        rows.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(rows.find((r) => r.id === where.id)!, data)),
      delete: vi.fn(async () => undefined),
    },
  } as unknown as PrismaService;
  const service = {
    ensure: vi.fn(async (id: string, spec: { phone: string; auth: string }) => ({ id, kind: 'whatsapp', phone: spec.phone, auth: spec.auth, state: 'pairing', code: 'ABCD1234', qr: null, account: null, error: null, updatedAt: '' })),
    list: vi.fn(async () => []),
    remove: vi.fn(async () => ({ ok: true })),
  } as unknown as MessengerServiceClient;
  return { svc: new MessengersService(prisma, service), service, rows };
}

describe('Мессенджеры портала', () => {
  it('создание WhatsApp: номер — цифрами, код для входа сразу в ответе', async () => {
    const t = setup();
    const m = await t.svc.create('p1', 7, { kind: 'whatsapp', phone: '8 (999) 123-45-67' });
    expect(m).toMatchObject({ kind: 'whatsapp', phone: '79991234567', auth: 'code', state: 'pairing', code: 'ABCD1234' });
    expect(t.service.ensure).toHaveBeenCalledWith(m.id, { kind: 'whatsapp', phone: '79991234567', auth: 'code' });
  });

  it('Telegram и MAX пока не подключаются; неверный номер и повтор — ошибка', async () => {
    const t = setup();
    await expect(t.svc.create('p1', 7, { kind: 'telegram', phone: '79991234567' })).rejects.toMatchObject({ response: { code: 'KIND_NOT_READY' } });
    await expect(t.svc.create('p1', 7, { kind: 'whatsapp', phone: '12' })).rejects.toMatchObject({ response: { code: 'INVALID_PHONE' } });
    await t.svc.create('p1', 7, { kind: 'whatsapp', phone: '79991234567' });
    await expect(t.svc.create('p1', 7, { kind: 'whatsapp', phone: '+7 999 123 45 67' })).rejects.toMatchObject({ response: { code: 'MESSENGER_EXISTS' } });
  });

  it('чужой портал не видит и не трогает мессенджер', async () => {
    const t = setup();
    const m = await t.svc.create('p1', 7, { kind: 'whatsapp', phone: '79991234567' });
    expect(await t.svc.list('p2')).toEqual([]);
    await expect(t.svc.remove('p2', m.id)).rejects.toMatchObject({ response: { code: 'MESSENGER_NOT_FOUND' } });
    await expect(t.svc.vncTicket('p2', 7, m.id)).rejects.toMatchObject({ response: { code: 'MESSENGER_NOT_FOUND' } });
    expect(t.service.remove).not.toHaveBeenCalled();
  });

  it('сервис потерял экземпляр — список поднимает его снова с тем же способом входа', async () => {
    const t = setup();
    const m = await t.svc.create('p1', 7, { kind: 'whatsapp', phone: '79991234567', auth: 'qr' });
    vi.mocked(t.service.ensure).mockClear();
    await t.svc.list('p1');
    expect(t.service.ensure).toHaveBeenCalledWith(m.id, expect.objectContaining({ auth: 'qr' }));
  });

  it('сервис недоступен — список из базы с пометкой', async () => {
    const t = setup();
    await t.svc.create('p1', 7, { kind: 'whatsapp', phone: '79991234567' });
    vi.mocked(t.service.list).mockRejectedValueOnce(new Error('down'));
    expect((await t.svc.list('p1'))[0].state).toBe('unavailable');
  });
});

describe('Билеты на экран VNC', () => {
  it('одноразовые и живут минуту', () => {
    let now = 0;
    const tickets = new VncTickets(() => now);
    const a = tickets.issue({ messengerId: 'm1', portalId: 'p1', userId: 7 });
    expect(tickets.take(a)).toMatchObject({ messengerId: 'm1' });
    expect(tickets.take(a)).toBeNull();
    const b = tickets.issue({ messengerId: 'm1', portalId: 'p1', userId: 7 });
    now = VNC_TICKET_TTL_MS + 1;
    expect(tickets.take(b)).toBeNull();
  });
});
