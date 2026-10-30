import { ClientBookingsService } from './client-bookings.service.js';
import type { DealFieldMapService } from './deal-field-map.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';

const ts = (iso: string) => Date.parse(iso) / 1000;
const bk = (id: number, from: string, to: string) => ({ id, resourceIds: [10], datePeriod: { from: { timestamp: ts(from) }, to: { timestamp: ts(to) } } });

describe('ClientBookingsService', () => {
  it('past / now / future from client bookings and from deal fields; open deals for a new booking', async () => {
    const call = vi.fn(async (method: string) => {
      if (method === 'crm.contact.get') return { result: { NAME: 'Анна', LAST_NAME: 'Иванова' } };
      if (method === 'booking.v1.booking.list')
        return { result: { booking: [bk(1, '2026-10-01T10:00:00Z', '2026-10-01T12:00:00Z'), bk(2, '2026-10-25T10:00:00Z', '2026-10-25T12:00:00Z')] } };
      throw new Error(method);
    });
    const listAll = vi.fn(async (_m: string, params: { filter: Record<string, unknown> }) =>
      params.filter.CONTACT_ID
        ? [
            { ID: '700', TITLE: 'Баня, октябрь', STAGE_SEMANTIC_ID: 'S', CATEGORY_ID: '0', OPPORTUNITY: '40000', UF_ID: '1', UF_S: null, UF_E: null },
            { ID: '701', TITLE: 'Баня, сейчас', STAGE_SEMANTIC_ID: 'P', CATEGORY_ID: '0', OPPORTUNITY: '0', UF_ID: '3', UF_S: null, UF_E: null },
            { ID: '702', TITLE: 'Старая', STAGE_SEMANTIC_ID: 'S', CATEGORY_ID: '0', OPPORTUNITY: '0', UF_ID: '4', UF_S: '2025-05-01T10:00:00+03:00', UF_E: '2025-05-01T12:00:00+03:00' },
            // Оплаченный сертификат (в работе, брони нет) — состоявшаяся; неоплаченный — нет.
            { ID: '703', TITLE: 'Сертификат', STAGE_SEMANTIC_ID: 'P', CATEGORY_ID: '0', OPPORTUNITY: '100000', UF_T: '74', UF_P: '100000|RUB' },
            { ID: '704', TITLE: 'Сертификат, не оплачен', STAGE_SEMANTIC_ID: 'P', CATEGORY_ID: '0', OPPORTUNITY: '50000', UF_T: '74', UF_P: '' },
          ]
        : [],
    );
    const batch = vi.fn(async (cmds: Record<string, unknown>) => {
      if (Object.keys(cmds)[0].startsWith('b1') || 'b2' in cmds) return { result: { b1: { externalData: [{ moduleId: 'crm', entityTypeId: 'DEAL', value: '700' }] }, b2: { externalData: [] } } };
      return { result: { b3: { booking: bk(3, '2026-10-21T09:00:00Z', '2026-10-21T13:00:00Z') } } }; // b4 — удалена
    });
    const prisma = {
      resource: { findMany: vi.fn(async () => [{ resourceId: 10, name: 'Баня 1' }, { resourceId: 14, name: 'Теремок' }]) },
      // Журнал: ресурсы удалённой брони 4; активных броней сделок, которых нет в модуле, — нет.
      bookingRecord: { findMany: vi.fn(async ({ where }: { where: { status?: string } }) => (where.status ? [] : [{ bookingId: 4, resourceIds: [14] }])) },
    } as unknown as PrismaService;
    const fieldMap = {
      get: vi.fn(async () => ({ bookingId: 'UF_ID', bookingStart: 'UF_S', bookingEnd: 'UF_E' })),
      outcome: vi.fn(async () => ({ bookingEnd: 'UF_E', dealType: 'UF_T', paidAmount: 'UF_P', certificateTypeId: '74' })),
    } as unknown as DealFieldMapService;
    const user = { portal: { id: 'p1' }, client: { call, listAll, batch } } as unknown as B24UserContext;
    const r = await new ClientBookingsService(prisma, fieldMap).forContact(user, 140, [], new Date('2026-10-21T10:00:00Z'));
    expect(r.past).toBe(2);
    expect(r.contact).toEqual({ id: 140, name: 'Анна Иванова' });
    expect(r.won).toEqual({ count: 3, avgCheck: 70000, currency: null });
    expect(r.upcoming.map((b) => [b.bookingId, b.when, b.dealId])).toEqual([
      [3, 'now', 701],
      [2, 'future', null],
    ]);
    expect(r.recent.map((b) => [b.bookingId, b.dealId, b.deal?.title, b.resources])).toEqual([
      [1, 700, 'Баня, октябрь', ['Баня 1']],
      // b4 удалена в модуле — ресурс из журнала приложения, bookingId null.
      [null, 702, 'Старая', ['Теремок']],
    ]);
    expect(r.openDeals.map((d) => d.id)).toEqual([701, 703, 704]);
    // Сделка с текущей бронью — с бронью (мастер выделит её).
    expect(r.openDeals[0]).toMatchObject({ opportunity: 0, booking: { resources: ['Баня 1'] } });
    expect(r.openDeals[1].booking).toBeNull();
  });
});

describe('ClientBookingsService recent', () => {
  it('chat: contact and deal of the dialog, full past list on request', async () => {
    const call = vi.fn(async () => ({ result: { entity_data_2: 'LEAD|0|COMPANY|0|CONTACT|140|DEAL|700' } }));
    const service = new ClientBookingsService({} as PrismaService, {} as DealFieldMapService);
    const forContact = vi.spyOn(service, 'forContact').mockResolvedValue({} as Awaited<ReturnType<ClientBookingsService['forContact']>>);
    const user = { portal: { id: 'p1' }, client: { call } } as unknown as B24UserContext;
    await service.forChat(user, 5);
    expect(forContact).toHaveBeenLastCalledWith(user, 140, [700], expect.any(Date), false);
    await service.forChat(user, 5, true);
    expect(forContact).toHaveBeenLastCalledWith(user, 140, [700], expect.any(Date), true);
  });

  it('keeps past bookings of the requested deal beyond the last five', async () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, resourceIds: [10], datePeriod: { from: { timestamp: Date.parse(`2026-0${i + 1}-01T10:00:00Z`) / 1000 }, to: { timestamp: Date.parse(`2026-0${i + 1}-01T12:00:00Z`) / 1000 } } }));
    const call = vi.fn(async (method: string) => (method === 'crm.contact.get' ? { result: {} } : { result: { booking: many } }));
    const listAll = vi.fn(async () => []);
    const batch = vi.fn(async (cmds: Record<string, unknown>) => ({
      result: Object.fromEntries(Object.keys(cmds).map((k) => [k, { externalData: k === 'b1' ? [{ moduleId: 'crm', entityTypeId: 'DEAL', value: '678' }] : [] }])),
    }));
    const prisma = { resource: { findMany: vi.fn(async () => []) } } as unknown as PrismaService;
    const fieldMap = { get: vi.fn(async () => ({})), outcome: vi.fn(async () => ({ certificateTypeId: null })) } as unknown as DealFieldMapService;
    const user = { portal: { id: 'p1' }, client: { call, listAll, batch } } as unknown as B24UserContext;
    const r = await new ClientBookingsService(prisma, fieldMap).forContact(user, 140, [678], new Date('2026-10-21T10:00:00Z'));
    expect(r.past).toBe(7);
    expect(r.recent.map((b) => b.bookingId)).toEqual([7, 6, 5, 4, 3, 1]);
  });
});

describe('ClientBookingsService cancelled', () => {
  it('does not show a booking cancelled via the app although deal fields still hold it', async () => {
    const call = vi.fn(async (method: string) => (method === 'crm.contact.get' ? { result: {} } : { result: { booking: [] } }));
    const listAll = vi.fn(async (_m: string, params: { filter: Record<string, unknown> }) =>
      params.filter.CONTACT_ID ? [{ ID: '678', TITLE: 'Тест', STAGE_SEMANTIC_ID: 'P', CATEGORY_ID: '0', UF_ID: '5992', UF_S: '2026-10-26T10:00:00+03:00', UF_E: '2026-10-27T22:00:00+03:00' }] : [],
    );
    const batch = vi.fn(async () => ({ result: { b5992: { booking: null } } }));
    const prisma = {
      resource: { findMany: vi.fn(async () => []) },
      bookingRecord: { findMany: vi.fn(async ({ where }: { where: { status?: string } }) => (where.status ? [] : [{ bookingId: 5992, resourceIds: [54], status: 'cancelled' }])) },
    } as unknown as PrismaService;
    const fieldMap = {
      get: vi.fn(async () => ({ bookingId: 'UF_ID', bookingStart: 'UF_S', bookingEnd: 'UF_E' })),
      outcome: vi.fn(async () => ({ certificateTypeId: null })),
    } as unknown as DealFieldMapService;
    const user = { portal: { id: 'p1' }, client: { call, listAll, batch } } as unknown as B24UserContext;
    const r = await new ClientBookingsService(prisma, fieldMap).forContact(user, 140, [], new Date('2026-10-26T01:00:00Z'));
    expect(r.upcoming).toEqual([]);
    expect(r.openDeals[0].booking).toBeNull();
  });
});
