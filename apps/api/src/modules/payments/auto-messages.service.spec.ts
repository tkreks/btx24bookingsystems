import { Prisma } from '../../generated/prisma/client.js';
import { AutoMessagesService, due } from './auto-messages.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { PaymentFlow } from './payment-flow.js';
import type { BookingJournalService } from '../bookings/booking-journal.service.js';
import type { Portal } from '../../generated/prisma/client.js';

const msk = (s: string) => Date.parse(`${s}+03:00`);
const rule = { id: 'confirm', enabled: true, name: 'Подтвердите бронь', trigger: 'before_start' as const, hoursBefore: 24, windowFrom: '09:00', windowTo: '22:00', templateId: 't1' };
const portal = { id: 'p1', timezone: 'Europe/Moscow' } as Portal;
const rec = (bookingId: number, start: string, created = '2026-10-20T10:00:00') => ({
  bookingId,
  dealId: 700 + bookingId,
  resourceIds: [14],
  startsAt: new Date(msk(start)),
  createdAt: new Date(msk(created)),
});

function setup(o: { logged?: number[]; noChat?: boolean } = {}) {
  const logs: Record<string, unknown>[] = [];
  const prisma = {
    workGroup: { findMany: vi.fn(async () => [{ options: { autoMessages: [rule, { ...rule, id: 'off', enabled: false }] }, resources: [{ resourceId: 14 }] }]) },
    bookingRecord: { findMany: vi.fn(async () => [rec(1, '2026-10-24T15:00:00'), rec(2, '2026-10-24T18:00:00'), rec(3, '2026-10-24T15:00:00', '2026-10-24T09:00:00'), rec(4, '2026-10-24T15:00:00')]) },
    autoMessageLog: {
      create: vi.fn(async ({ data }: { data: { bookingId: number } }) => {
        if (o.logged?.includes(data.bookingId)) throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' });
        logs.push(data);
        return { id: `l${data.bookingId}` };
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => logs.push(data)),
    },
    messageTemplate: { findFirst: vi.fn(async () => ({ id: 't1', steps: [{ text: 'Здравствуйте, {client_name}! Просим подтвердить бронирование.', fileIds: [] }] })) },
  } as unknown as PrismaService;
  const flow = {
    messages: vi.fn(async () => ({ vars: {}, dealByTitle: {}, dealByCode: {}, contact: {}, variables: { client_name: 'Анна' }, deal: { ID: '701' } })),
    withFileData: vi.fn(async (_p: string, steps: unknown) => steps),
    sendChain: vi.fn(async () => !o.noChat),
    comment: vi.fn(async () => undefined),
  };
  const journal = { pendingRemoval: vi.fn(async () => new Set([4])) };
  const svc = new AutoMessagesService(prisma, flow as unknown as PaymentFlow, journal as unknown as BookingJournalService);
  return { svc, flow, logs };
}

describe('AutoMessagesService', () => {
  it('за сутки в рабочее окно: одна отправка на правило и бронь; поздняя бронь, пропавшая в Битрикс24 и выключенное правило — без рассылки', async () => {
    const t = setup();
    const r = await t.svc.run(portal, {} as never, msk('2026-10-23T15:05:00'));
    expect(r).toEqual({ sent: 1, failed: 0 });
    expect(t.flow.sendChain).toHaveBeenCalledTimes(1);
    expect(t.flow.sendChain).toHaveBeenCalledWith(expect.anything(), { dealId: 701, userId: null, source: 'auto' }, { ID: '701' }, [expect.objectContaining({ text: expect.stringContaining('Просим подтвердить') })], expect.any(Array));
    expect(t.logs.at(-1)).toMatchObject({ status: 'sent' });
  });

  it('повтор прохода не задвоит; нет чата — «не отправлено» без повтора', async () => {
    const again = setup({ logged: [1] });
    expect(await again.svc.run(portal, {} as never, msk('2026-10-23T15:05:00'))).toEqual({ sent: 0, failed: 0 });
    const noChat = setup({ noChat: true });
    expect(await noChat.svc.run(portal, {} as never, msk('2026-10-23T15:05:00'))).toEqual({ sent: 0, failed: 1 });
    expect(noChat.logs.at(-1)).toMatchObject({ status: 'failed' });
  });

  it('due: ночью ждёт утра, вне окна не шлёт, после начала брони — нет', () => {
    const r = { startsAt: new Date(msk('2026-10-24T07:00:00')), createdAt: new Date(msk('2026-10-20T10:00:00')) };
    expect(due(r, rule, 'Europe/Moscow', msk('2026-10-23T07:30:00'))).toBe(false);
    expect(due(r, rule, 'Europe/Moscow', msk('2026-10-23T09:02:00'))).toBe(true);
    expect(due(r, rule, 'Europe/Moscow', msk('2026-10-23T23:00:00'))).toBe(false);
    expect(due(r, rule, 'Europe/Moscow', msk('2026-10-24T08:00:00'))).toBe(false);
  });
});
