import { CalendarService } from './calendar.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import type { Bitrix24RestClient } from '../bitrix24/rest/rest-client.js';

function fakeClient(bookings: (from: number, to: number) => unknown[], opts: { deals?: Record<string, string>[]; links?: Record<number, number> } = {}) {
  const listCalls: [number, number][] = [];
  const client = {
    listAll: vi.fn(async (method: string, _p: unknown, o?: { pick?: (r: unknown) => unknown[] }) => {
      if (method === 'booking.v1.resource.list') return o!.pick!({ resource: [{ id: 2, name: 'Баня 2' }, { id: 1, name: 'Баня 1' }] });
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

const user = (client: Bitrix24RestClient) => ({ portal: { timezone: 'Europe/Moscow' }, client, userId: 1, userName: 'U', isAdmin: false }) as unknown as B24UserContext;
const booking = (id: number, fromSec: number, toSec: number, resourceIds = [1]) => ({ id, name: `B${id}`, resourceIds, datePeriod: { from: { timestamp: fromSec }, to: { timestamp: toSec } } });

describe('CalendarService', () => {
  it('asks for the Moscow day and maps bookings, resources and deals', async () => {
    const dayStart = Date.UTC(2026, 9, 20, 21) / 1000;
    const { client, listCalls } = fakeClient(() => [booking(7, dayStart + 3600, dayStart + 7200)], {
      links: { 7: 501 },
      deals: [{ ID: '501', TITLE: 'Иванов', CATEGORY_ID: '14', STAGE_ID: 'C14:NEW', OPPORTUNITY: '12000.00', CURRENCY_ID: 'RUB' }],
    });
    const day = await new CalendarService().day(user(client), '2026-10-21');
    expect(listCalls).toEqual([[dayStart, dayStart + 86400]]);
    expect(day.resources.map((r) => r.name)).toEqual(['Баня 1', 'Баня 2']);
    expect(day.bookings[0]).toMatchObject({ id: 7, start: '2026-10-20T22:00:00.000Z', dealId: 501, deal: { title: 'Иванов', categoryId: 14, opportunity: 12000 } });
  });

  it('keeps dealId but hides deal data the user cannot see', async () => {
    const { client } = fakeClient(() => [booking(8, 0, 60)], { links: { 8: 999 }, deals: [] });
    const day = await new CalendarService().day(user(client), '2026-10-21');
    expect(day.bookings[0]).toMatchObject({ dealId: 999, deal: null });
  });

  it('splits the interval when the 50-item cap is hit and de-duplicates', async () => {
    const from = 0;
    const to = 86400;
    // 60 броней по часу каждые 20 минут; бронь 1 пересекает середину отрезка.
    const all = Array.from({ length: 60 }, (_, i) => booking(i + 1, i * 1200, i * 1200 + 3600));
    const { client, listCalls } = fakeClient((a, b) => all.filter((x) => x.datePeriod.from.timestamp < b && x.datePeriod.to.timestamp > a).slice(0, 50));
    const got = await new CalendarService().bookings(client, from, to);
    expect(got).toHaveLength(60);
    expect(new Set(got.map((b) => b.id)).size).toBe(60);
    expect(listCalls.length).toBeGreaterThan(1);
  });

  it('does not query deals when there are no links', async () => {
    const { client } = fakeClient(() => [booking(1, 0, 60)]);
    await new CalendarService().day(user(client), '2026-10-21');
    expect((client.listAll as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual(['booking.v1.resource.list']);
  });
});
