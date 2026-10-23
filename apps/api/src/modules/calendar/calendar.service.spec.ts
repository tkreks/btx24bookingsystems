import { CalendarService } from './calendar.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import type { Bitrix24RestClient } from '../bitrix24/rest/rest-client.js';

function fakeClient(
  bookings: (from: number, to: number) => unknown[],
  opts: { deals?: Record<string, string>[]; links?: Record<number, number> } = {},
) {
  const listCalls: [number, number][] = [];
  const client = {
    listAll: vi.fn(async (method: string, _p: unknown, o?: { pick?: (r: unknown) => unknown[] }) => {
      if (method === 'booking.v1.resource.list')
        return o!.pick!({
          resource: [
            { id: 2, name: 'Баня 2' },
            { id: 1, name: 'Баня 1' },
          ],
        });
      if (method === 'crm.deal.list') return opts.deals ?? [];
      return [];
    }),
    call: vi.fn(async (_m: string, p: { filter: { within: { dateFrom: number; dateTo: number } } }) => {
      const { dateFrom, dateTo } = p.filter.within;
      listCalls.push([dateFrom, dateTo]);
      return { result: { booking: bookings(dateFrom, dateTo) } };
    }),
    batch: vi.fn(async (cmds: Record<string, { params: { bookingId: number } }>) => ({
      result: Object.fromEntries(
        Object.entries(cmds).map(([k, c]) => {
          const deal = opts.links?.[c.params.bookingId];
          return [k, { externalData: deal ? [{ moduleId: 'crm', entityTypeId: 'DEAL', value: String(deal) }] : [] }];
        }),
      ),
      errors: {},
      total: {},
      next: {},
    })),
  };
  return { client: client as unknown as Bitrix24RestClient, listCalls };
}

const user = (client: Bitrix24RestClient) =>
  ({
    portal: { timezone: 'Europe/Moscow' },
    client,
    userId: 1,
    userName: 'U',
    isAdmin: false,
  }) as unknown as B24UserContext;
/** Начало дня 2026-10-21 по Москве, секунды. */
const D = Date.UTC(2026, 9, 20, 21) / 1000;
const booking = (id: number, fromSec: number, toSec: number, resourceIds = [1]) => ({
  id,
  name: `B${id}`,
  resourceIds,
  datePeriod: { from: { timestamp: fromSec }, to: { timestamp: toSec } },
});

describe('CalendarService', () => {
  it('asks for the Moscow day and maps bookings, resources and deals', async () => {
    const dayStart = Date.UTC(2026, 9, 20, 21) / 1000;
    const { client, listCalls } = fakeClient(() => [booking(7, dayStart + 3600, dayStart + 7200)], {
      links: { 7: 501 },
      deals: [
        {
          ID: '501',
          TITLE: 'Иванов',
          CATEGORY_ID: '14',
          STAGE_ID: 'C14:NEW',
          OPPORTUNITY: '12000.00',
          CURRENCY_ID: 'RUB',
        },
      ],
    });
    const day = await new CalendarService().day(user(client), '2026-10-21');
    expect(listCalls).toEqual([[dayStart, dayStart + 86400]]);
    expect(day.resources.map((r) => r.name)).toEqual(['Баня 1', 'Баня 2']);
    expect(day.bookings[0]).toMatchObject({
      id: 7,
      start: '2026-10-20T22:00:00.000Z',
      dealId: 501,
      deal: { title: 'Иванов', categoryId: 14, opportunity: 12000 },
    });
  });

  it('keeps dealId but hides deal data the user cannot see', async () => {
    const { client } = fakeClient(() => [booking(8, D, D + 60)], { links: { 8: 999 }, deals: [] });
    const day = await new CalendarService().day(user(client), '2026-10-21');
    expect(day.bookings[0]).toMatchObject({ dealId: 999, deal: null });
  });

  it('splits the interval when the 50-item cap is hit and de-duplicates', async () => {
    const from = 0;
    const to = 86400;
    // 60 броней по часу каждые 20 минут; бронь 1 пересекает середину отрезка.
    const all = Array.from({ length: 60 }, (_, i) => booking(i + 1, i * 1200, i * 1200 + 3600));
    const { client, listCalls } = fakeClient((a, b) =>
      all.filter((x) => x.datePeriod.from.timestamp < b && x.datePeriod.to.timestamp > a).slice(0, 50),
    );
    const got = await new CalendarService().bookings(client, from, to);
    expect(got).toHaveLength(60);
    expect(new Set(got.map((b) => b.id)).size).toBe(60);
    expect(listCalls.length).toBeGreaterThan(1);
  });

  it('limits the day to the group resources', async () => {
    const { client } = fakeClient(() => [booking(1, D, D + 60, [1]), booking(2, D, D + 60, [2])], {
      links: { 1: 10, 2: 20 },
    });
    const day = await new CalendarService().day(user(client), '2026-10-21', { resourceIds: [2] });
    expect(day.resources.map((r) => r.id)).toEqual([2]);
    expect(day.bookings.map((b) => b.id)).toEqual([2]);
  });

  it('returns occupancy only without booking.details (no names, deals or extra REST calls)', async () => {
    const { client } = fakeClient(() => [booking(1, D, D + 60)], {
      links: { 1: 10 },
      deals: [{ ID: '10', TITLE: 'Секрет' }],
    });
    const day = await new CalendarService().day(user(client), '2026-10-21', { withDetails: false });
    expect(day.bookings[0]).toMatchObject({ name: 'Занято', description: null, dealId: null, deal: null });
    expect(client.batch).not.toHaveBeenCalled();
  });

  it('does not query deals when there are no links', async () => {
    const { client } = fakeClient(() => [booking(1, D, D + 60)]);
    await new CalendarService().day(user(client), '2026-10-21');
    expect((client.listAll as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([
      'booking.v1.resource.list',
    ]);
  });

  it('adds tech windows after bookings, including one spilling over from the previous day', async () => {
    const { client, listCalls } = fakeClient(() => [
      booking(1, D - 7200, D - 1800), // вчера 22:00–23:30 → окно до 00:30
      booking(2, D + 3600, D + 7200), // 01:00–02:00 → окно 02:00–03:00
      booking(3, D + 7200, D + 14400), // 02:00–04:00 перекрывает окно брони 2 целиком
    ]);
    const day = await new CalendarService().day(user(client), '2026-10-21', { techWindowMinutes: 60 });
    expect(listCalls[0]).toEqual([D - 3600, D + 86400]);
    expect(day.bookings.map((b) => b.id)).toEqual([2, 3]);
    expect(day.techWindows).toEqual([
      {
        resourceId: 1,
        bookingId: 1,
        start: new Date((D - 1800) * 1000).toISOString(),
        end: new Date((D + 1800) * 1000).toISOString(),
      },
      {
        resourceId: 1,
        bookingId: 3,
        start: new Date((D + 14400) * 1000).toISOString(),
        end: new Date((D + 18000) * 1000).toISOString(),
      },
    ]);
  });

  it('returns configured deal fields formatted, and asks only for them', async () => {
    const { client } = fakeClient(() => [booking(7, D + 3600, D + 7200)], {
      links: { 7: 501 },
      deals: [{ ID: '501', TITLE: 'Иванов', UF_GUESTS: '4', UF_KIND: '12', UF_HIDDEN: 'x' }],
    });
    (client as unknown as { call: ReturnType<typeof vi.fn> }).call.mockImplementation(async (m: string) =>
      m === 'crm.deal.fields'
        ? {
            result: {
              UF_GUESTS: { type: 'integer', formLabel: 'Гостей' },
              UF_KIND: { type: 'enumeration', listLabel: 'Вид', items: [{ ID: '12', VALUE: 'Баня' }] },
            },
          }
        : { result: { booking: [booking(7, D + 3600, D + 7200)] } },
    );
    const flags = { required: false, inlineNext: false, showCreate: true };
    const day = await new CalendarService().day(user(client), '2026-10-21', {
      dealFields: [
        { name: 'UF_GUESTS', ...flags, showView: true, showList: true },
        { name: 'UF_KIND', ...flags, showView: true, showList: false },
        { name: 'UF_HIDDEN', ...flags, showView: false, showList: false },
      ],
    });
    expect(day.bookings[0].fields).toEqual([
      { code: 'UF_GUESTS', label: 'Гостей', value: '4', inList: true, inView: true },
      { code: 'UF_KIND', label: 'Вид', value: 'Баня', inList: false, inView: true },
    ]);
    const dealCall = (client.listAll as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === 'crm.deal.list');
    expect(dealCall?.[1]).toMatchObject({ select: expect.arrayContaining(['UF_GUESTS', 'UF_KIND']) });
    expect((dealCall![1] as { select: string[] }).select).not.toContain('UF_HIDDEN');
  });
});

describe('CalendarService — bookings deleted in Bitrix24', () => {
  it('keeps an app booking that is gone in Bitrix24 on its place, marked missing, until a decision', async () => {
    const { client } = fakeClient(() => [booking(7, D + 3600, D + 7200)]);
    // booking.get пачкой: 8 — удалена, 9 — перенесли на другой день (есть), 10 — сбой проверки.
    (client.batch as ReturnType<typeof vi.fn>).mockImplementation(async (cmds: Record<string, { method: string }>) =>
      Object.values(cmds)[0].method === 'booking.v1.booking.get'
        ? { result: { b9: { booking: { id: 9 } } }, errors: { b8: { error: '1021', error_description: 'Booking not found' }, b10: { error: 'INTERNAL' } }, total: {}, next: {} }
        : { result: {}, errors: {}, total: {}, next: {} },
    );
    const rec = (bookingId: number, resourceIds = [1]) => ({
      bookingId,
      title: `R${bookingId}`,
      dealId: null,
      resourceIds,
      startsAt: new Date((D + 10_800) * 1000),
      endsAt: new Date((D + 14_400) * 1000),
    });
    const prisma = {
      bookingRecord: { findMany: vi.fn(async () => [rec(7), rec(8), rec(9), rec(10), rec(11, [2])]) },
      resourceStop: { findMany: vi.fn(async () => []) },
      bookingAlert: { findMany: vi.fn(async () => [{ id: 'a8', bookingId: 8 }]) },
    };
    const day = await new CalendarService(prisma as never).day({ ...user(client), portal: { id: 'p1', timezone: 'Europe/Moscow' } } as B24UserContext, '2026-10-21', {
      resourceIds: [1],
    });
    expect(day.bookings.map((b) => [b.id, b.missing ?? null])).toEqual([
      [7, null],
      [8, { alertId: 'a8' }],
    ]);
    expect(day.bookings[1]).toMatchObject({ name: 'R8', resourceIds: [1], start: new Date((D + 10_800) * 1000).toISOString() });
    // Пропавшая бронь не даёт тех. окна: слот в Битрикс24 свободен.
    expect(day.techWindows.every((t) => t.bookingId !== 8)).toBe(true);
  });
});
