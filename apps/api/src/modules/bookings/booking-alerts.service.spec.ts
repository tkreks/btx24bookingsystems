import { Prisma } from '../../generated/prisma/client.js';
import { BookingAlertsService, fingerprint } from './booking-alerts.service.js';
import type { BookingJournalService } from './booking-journal.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { PortalService } from '../bitrix24/portals/portal.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import type { Bitrix24RestClient } from '../bitrix24/rest/rest-client.js';
import type { Portal } from '../../generated/prisma/client.js';

const portal = { id: 'p1', timezone: 'Europe/Moscow' } as Portal;
const state = { startsAt: '2026-10-23T11:00:00.000Z', endsAt: '2026-10-23T13:00:00.000Z', resourceIds: [10], dealId: 678 };
const alertRow = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  portalId: 'p1',
  kind: 'discrepancy',
  problem: 'time',
  bookingId: 55,
  dealId: 678,
  expected: state,
  actual: { ...state, startsAt: '2026-10-23T12:00:00.000Z', title: 'Баня' },
  fingerprint: 'f',
  status: 'new',
  statusByUserId: null,
  statusByName: null,
  statusAt: null,
  chatId: null,
  messageId: null,
  sendError: null,
  createdAt: new Date(),
  ...over,
});

function setup(o: { alerts?: ReturnType<typeof alertRow>[]; chatId?: number | null; record?: Record<string, unknown> | null } = {}) {
  const rows = o.alerts ?? [alertRow()];
  const prisma = {
    bookingAlert: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'new', ...data })),
      findMany: vi.fn(async () => rows),
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const r = rows.find((x) => x.id === where.id)!;
        Object.assign(r, data);
        return r;
      }),
    },
    portalSettings: { findUnique: vi.fn(async () => ({ alertChatId: o.chatId === undefined ? 777 : o.chatId })) },
    resource: { findMany: vi.fn(async () => [{ resourceId: 10, name: 'Баня №1' }]) },
  } as unknown as PrismaService;
  const appClient = {
    call: vi.fn(async (method: string) => (method === 'app.info' ? { result: { ID: 12 } } : { result: 9001 })),
  } as unknown as Bitrix24RestClient;
  const portals = { clientFor: () => appClient } as unknown as PortalService;
  const journal = {
    find: vi.fn(async () => (o.record === undefined ? { id: 'r1', status: 'active' } : o.record)),
    recordChanged: vi.fn(async () => ({})),
    recordCancelled: vi.fn(async () => ({})),
    note: vi.fn(async () => undefined),
  };
  const userClient = { call: vi.fn(async () => ({ result: true })) };
  const user = { portal, userId: 7, userName: 'Анна', client: userClient } as unknown as B24UserContext;
  return { svc: new BookingAlertsService(prisma, portals, journal as unknown as BookingJournalService), prisma, appClient, journal, user, userClient, rows };
}

describe('BookingAlertsService', () => {
  it('one alert per discrepancy: duplicate fingerprint → null', async () => {
    const t = setup();
    (t.prisma.bookingAlert.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
    );
    const input = { kind: 'discrepancy' as const, problems: ['time' as const], bookingId: 55, dealId: 678, expected: state, actual: state };
    expect(await t.svc.raise('p1', input)).toBeNull();
    expect(fingerprint(input)).toBe(fingerprint({ ...input, actual: { ...state, resourceIds: [10] } }));
    expect(fingerprint(input)).not.toBe(fingerprint({ ...input, actual: { ...state, dealId: 1 } }));
  });

  it('delivers pending alerts to the alert chat with buttons and stores the message id', async () => {
    const t = setup();
    expect(await t.svc.deliverPending(portal, t.appClient)).toBe(1);
    expect(t.appClient.call).toHaveBeenCalledWith(
      'im.message.add',
      expect.objectContaining({ DIALOG_ID: 'chat777', KEYBOARD: expect.arrayContaining([expect.objectContaining({ TEXT: 'Открыть сделку' })]) }),
    );
    expect(t.rows[0]).toMatchObject({ chatId: 777, messageId: 9001, sendError: null });
  });

  it('without alert chat nothing is sent', async () => {
    const t = setup({ chatId: null });
    expect(await t.svc.deliverPending(portal, t.appClient)).toBe(0);
    expect(t.appClient.call).not.toHaveBeenCalled();
  });

  it('status change records who and updates the chat message', async () => {
    const t = setup({ alerts: [alertRow({ chatId: 777, messageId: 9001 })] });
    const dto = await t.svc.setStatus(t.user, 'a1', { status: 'viewed' });
    expect(dto).toMatchObject({ status: 'viewed', statusBy: { id: 7, name: 'Анна' } });
    expect(t.appClient.call).toHaveBeenCalledWith('im.message.update', expect.objectContaining({ MESSAGE_ID: 9001, MESSAGE: expect.stringContaining('Просмотрен') }));
    await expect(t.svc.setStatus(t.user, 'a1', { status: 'done' })).rejects.toMatchObject({ status: 400 });
    await expect(t.svc.setStatus(t.user, 'zzz', { status: 'viewed' })).rejects.toMatchObject({ status: 404 });
  });

  it('accept as in Bitrix24 updates the record from the user, then «resolved»', async () => {
    const t = setup();
    await t.svc.resolve(t.user, 'a1', { resolution: 'accept_bitrix' });
    expect(t.journal.recordChanged).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'r1' }),
      expect.objectContaining({ startsAt: '2026-10-23T12:00:00.000Z' }),
      { kind: 'user', userId: 7, name: 'Анна' },
      'accepted_bitrix',
      'app',
    );
    expect(t.rows[0].status).toBe('resolved');
    expect(t.userClient.call).not.toHaveBeenCalled();
  });

  it('cancel deletes in Bitrix24 with the user token and cancels the record', async () => {
    const t = setup();
    await t.svc.resolve(t.user, 'a1', { resolution: 'cancel_booking' });
    expect(t.userClient.call).toHaveBeenCalledWith('booking.v1.booking.delete', { id: 55 });
    expect(t.journal.recordCancelled).toHaveBeenCalledWith('p1', 55, expect.objectContaining({ reason: 'manual' }));
  });

  it('missing booking: accept → cancelled «removed in Bitrix24»; cancel does not call delete', async () => {
    const t = setup({ alerts: [alertRow({ problem: 'missing', actual: null })] });
    await t.svc.resolve(t.user, 'a1', { resolution: 'accept_bitrix' });
    expect(t.journal.recordCancelled).toHaveBeenCalledWith('p1', 55, expect.objectContaining({ reason: 'removed_in_bitrix' }));
    const t2 = setup({ alerts: [alertRow({ problem: 'missing', actual: null })] });
    await t2.svc.resolve(t2.user, 'a1', { resolution: 'cancel_booking' });
    expect(t2.userClient.call).not.toHaveBeenCalled();
  });
});
