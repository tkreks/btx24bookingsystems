import { HeadDashboardService } from './head-dashboard.service.js';
import type { DashboardService } from './dashboard.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';

const msk = (s: string) => new Date(`${s}+03:00`).toISOString();
const call = (id: number, at: string, dir: 1 | 2, missed: boolean, phone: string, contact?: number) => ({
  ID: String(id),
  OWNER_ID: '1',
  OWNER_TYPE_ID: '3',
  DIRECTION: String(dir),
  START_TIME: msk(at),
  END_TIME: msk(at),
  RESPONSIBLE_ID: '7',
  SETTINGS: { MISSED_CALL: missed },
  COMMUNICATIONS: [{ VALUE: phone, ENTITY_TYPE_ID: contact ? 3 : 0, ENTITY_ID: contact ?? 0 }],
});

describe('HeadDashboardService', () => {
  it('по дням: новые сделки, брони по ним, повторные; звонки — все, пропущенные, упущенные (без перезвона и без чата)', async () => {
    const dashboard = {
      newDeals: vi.fn(async (_u: unknown, start: Date) =>
        // Прошлый период (20–21.10) — одна сделка.
        start.getTime() < Date.parse(msk('2026-10-22T00:00:00'))
          ? {
              total: 1,
              repeat: 0,
              truncated: false,
              items: [{ id: 9, createdAt: msk('2026-10-21T10:00:00'), repeat: false }],
            }
          : {
              total: 3,
              repeat: 1,
              truncated: false,
              items: [
                { id: 1, createdAt: msk('2026-10-22T10:00:00'), repeat: false },
                { id: 2, createdAt: msk('2026-10-23T11:00:00'), repeat: true },
                { id: 3, createdAt: msk('2026-10-23T12:00:00'), repeat: false },
              ],
            },
      ),
      fetchCalls: vi.fn(async () => ({
        truncated: false,
        rows: [
          call(1, '2026-10-23T10:00:00', 1, true, '+7 900 000-00-01'), // пропущен, перезвонили
          call(2, '2026-10-23T10:30:00', 2, false, '+7 900 000-00-01'),
          call(3, '2026-10-23T11:00:00', 1, true, '+7 900 000-00-02'), // пропущен, написали в чат — не упущен
          call(4, '2026-10-23T12:00:00', 1, true, '+7 900 000-00-03', 55), // упущен
          call(5, '2026-10-22T12:00:00', 1, false, '+7 900 000-00-04'),
          call(6, '2026-10-21T12:00:00', 1, true, '+7 900 000-00-05'), // прошлый период
        ],
      })),
    } as unknown as DashboardService;
    const prisma = {
      workGroup: { findMany: vi.fn(async () => [{ dealCategoryId: 0 }, { dealCategoryId: 14 }]) },
      bookingRecord: { findMany: vi.fn(async () => [{ dealId: 2 }, { dealId: 2 }, { dealId: 1 }]) },
      openlineChat: {
        findMany: vi.fn(async () => [
          { crm: { contactId: null }, phones: ['+79000000002'], lastMessageAt: new Date(msk('2026-10-23T11:20:00')) },
        ]),
      },
    } as unknown as PrismaService;
    const user = { portal: { id: 'p1', timezone: 'Europe/Moscow' }, userId: 7 } as unknown as B24UserContext;
    const r = await new HeadDashboardService(prisma, dashboard).get(user, { from: '2026-10-22', to: '2026-10-23' });
    expect(dashboard.newDeals).toHaveBeenCalledWith(user, expect.any(Date), expect.any(Date), 'all', [0, 14]);
    expect(
      r.days.map((d) => [d.date, d.newDeals, d.bookedDeals, d.bookings, d.repeat, d.calls, d.missed, d.lost]),
    ).toEqual([
      ['2026-10-22', 1, 1, 1, 0, 1, 0, 0],
      ['2026-10-23', 2, 1, 2, 1, 4, 3, 1],
    ]);
    expect(r.totals).toMatchObject({
      newDeals: 3,
      bookings: 3,
      calls: 5,
      missed: 3,
      lost: 1,
      incoming: 4,
      outgoing: 1,
    });
    expect(r.previous).toMatchObject({
      from: '2026-10-20',
      to: '2026-10-21',
      totals: { newDeals: 1, bookings: 0, calls: 1, missed: 1, lost: 1 },
    });
  });
});
