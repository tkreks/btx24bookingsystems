import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { AccessService } from '../access/access.service.js';
import type { ActionLogService } from '../audit/action-log.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { ResourceStopsService } from './resource-stops.service.js';

const ts = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function setup({ bookings = [] as { id: number; resourceIds: number[]; from: string; to: string }[], edit = true } = {}) {
  const stops: Record<string, unknown>[] = [];
  const prisma = {
    resourceStop: {
      findMany: vi.fn(async ({ where }: { where: { resourceId?: { in: number[] }; startsAt: { lt: Date }; endsAt: { gt: Date } } }) =>
        stops.filter(
          (s) =>
            (!where.resourceId || where.resourceId.in.includes(s.resourceId as number)) &&
            (s.startsAt as Date) < where.startsAt.lt &&
            (s.endsAt as Date) > where.endsAt.gt &&
            !s.liftedAt,
        ),
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const r = { id: `s${stops.length + 1}`, createdAt: new Date(), liftedAt: null, ...data };
        stops.push(r);
        return r;
      }),
    },
  } as unknown as PrismaService;
  const access = {
    resolve: vi.fn(async () => ({ isAppAdmin: false, groups: [{ permissions: edit ? ['booking.edit'] : ['calendar.view'], group: { resourceIds: [14] } }] })),
  } as unknown as AccessService;
  const log = { user: vi.fn(async () => undefined) } as unknown as ActionLogService;
  const client = {
    call: vi.fn(async (method: string) =>
      method === 'booking.v1.booking.list'
        ? { result: { booking: bookings.map((b) => ({ id: b.id, name: `Бронь ${b.id}`, resourceIds: b.resourceIds, datePeriod: { from: { timestamp: ts(b.from) }, to: { timestamp: ts(b.to) } } })) } }
        : { result: {} },
    ),
    batch: vi.fn(async () => ({ result: {}, errors: {} })),
  };
  const user = { portal: { id: 'p1', timezone: 'Europe/Moscow' }, userId: 7, userName: 'Анна', client } as unknown as B24UserContext;
  return { svc: new ResourceStopsService(prisma, access, log), user, stops };
}

describe('ResourceStopsService', () => {
  it('нет броней ресурса в периоде — стоп ставится на дни портала; бронь в стоп не создаётся', async () => {
    const t = setup({ bookings: [{ id: 1, resourceIds: [15], from: '2026-11-02T10:00:00Z', to: '2026-11-02T12:00:00Z' }] });
    const s = await t.svc.create(t.user, { resourceId: 14, from: '2026-11-01', to: '2026-11-03', reason: 'Ремонт печи' });
    expect(s).toMatchObject({ resourceId: 14, from: '2026-11-01', to: '2026-11-03', start: '2026-10-31T21:00:00.000Z', end: '2026-11-03T21:00:00.000Z', reason: 'Ремонт печи' });
    await expect(t.svc.assertOpen('p1', [14], new Date('2026-11-02T10:00:00Z'), new Date('2026-11-02T12:00:00Z'), 'Europe/Moscow')).rejects.toBeInstanceOf(ConflictException);
    await expect(t.svc.assertOpen('p1', [14], new Date('2026-11-04T10:00:00Z'), new Date('2026-11-04T12:00:00Z'), 'Europe/Moscow')).resolves.toBeUndefined();
  });

  it('есть брони ресурса — 409 со списком (перенести или отменить); без права — 403', async () => {
    const t = setup({ bookings: [{ id: 5, resourceIds: [14], from: '2026-11-02T10:00:00Z', to: '2026-11-02T12:00:00Z' }] });
    const check = await t.svc.check(t.user, { resourceId: 14, from: '2026-11-01', to: '2026-11-03' });
    expect(check.bookings).toMatchObject([{ id: 5, start: '2026-11-02T10:00:00.000Z' }]);
    await expect(t.svc.create(t.user, { resourceId: 14, from: '2026-11-01', to: '2026-11-03', reason: 'Ремонт' })).rejects.toBeInstanceOf(ConflictException);
    expect(t.stops).toHaveLength(0);
    await expect(setup({ edit: false }).svc.check(setup().user, { resourceId: 14, from: '2026-11-01', to: '2026-11-01' })).rejects.toBeInstanceOf(ForbiddenException);
  });
});
