import type { PrismaService } from '../../prisma/prisma.service.js';
import type { Bitrix24RestClient } from '../bitrix24/rest/rest-client.js';
import { Bitrix24Error } from '../bitrix24/rest/errors.js';
import { bookingLine, DealBookingFieldsService, dealBookingFieldValues, nearestBooking, sameFieldValue } from './deal-booking-fields.service.js';
import type { DealFieldMapService } from './deal-field-map.service.js';

const rec = (bookingId: number, start: string, end: string, resourceIds: number[] = [6], status = 'active') => ({
  bookingId,
  startsAt: new Date(start),
  endsAt: new Date(end),
  resourceIds,
  status,
});
const names = new Map([
  [6, 'Баня 6'],
  [7, 'Домик 2'],
]);
const map = { bookingId: 'UF_ID', bookingStart: 'UF_S', bookingEnd: 'UF_E', visitDateStart: 'UF_VD', visitTimeStart: 'UF_VT', bookingsList: 'UF_LIST', guests: 'UF_G' };
const now = new Date('2026-12-10T09:00:00Z');

describe('строка «Брони сделки»', () => {
  it('номер, ресурсы через запятую, начало и конец ISO со смещением пояса портала', () => {
    expect(bookingLine(rec(6060, '2026-12-15T01:00:00Z', '2026-12-15T05:00:00Z'), names, 'Europe/Moscow')).toBe(
      '#6060 | Баня 6 | 2026-12-15T04:00:00+03:00 | 2026-12-15T08:00:00+03:00',
    );
    // Пояс портала — не зашитая Москва; неизвестный ресурс — по номеру.
    expect(bookingLine(rec(7, '2026-12-15T01:00:00Z', '2026-12-15T05:00:00Z', [6, 7, 9]), names, 'Asia/Yekaterinburg')).toBe(
      '#7 | Баня 6, Домик 2, Ресурс #9 | 2026-12-15T06:00:00+05:00 | 2026-12-15T10:00:00+05:00',
    );
  });
});

describe('ближайшая бронь для одиночных полей', () => {
  const past = rec(1, '2026-12-01T10:00:00Z', '2026-12-01T12:00:00Z');
  const older = rec(2, '2026-11-01T10:00:00Z', '2026-11-01T12:00:00Z');
  const current = rec(3, '2026-12-10T08:00:00Z', '2026-12-10T10:00:00Z');
  const future = rec(4, '2026-12-20T08:00:00Z', '2026-12-20T10:00:00Z');
  const later = rec(5, '2027-01-20T08:00:00Z', '2027-01-20T10:00:00Z');
  it('текущая важнее будущей, ближайшая будущая — важнее дальней, иначе последняя прошедшая', () => {
    expect(nearestBooking([later, future, current, past], now)?.bookingId).toBe(3);
    expect(nearestBooking([later, future, past], now)?.bookingId).toBe(4);
    expect(nearestBooking([older, past], now)?.bookingId).toBe(1);
    expect(nearestBooking([], now)).toBeNull();
  });
});

describe('значения полей сделки', () => {
  it('список — все действующие по дате начала; одиночные — по ближайшей; ненастроенные роли не пишутся', () => {
    const v = dealBookingFieldValues(
      map,
      [rec(20, '2026-12-20T08:00:00Z', '2026-12-20T10:00:00Z', [7]), rec(10, '2026-12-01T08:00:00Z', '2026-12-01T10:00:00Z'), rec(15, '2026-12-15T08:00:00Z', '2026-12-15T10:00:00Z')],
      names,
      'Europe/Moscow',
      now,
    );
    expect(v).toEqual({
      UF_ID: '15',
      UF_S: '2026-12-15T11:00:00+03:00',
      UF_E: '2026-12-15T13:00:00+03:00',
      UF_VD: '15.12.2026',
      UF_VT: '11:00',
      UF_LIST: [
        '#10 | Баня 6 | 2026-12-01T11:00:00+03:00 | 2026-12-01T13:00:00+03:00',
        '#15 | Баня 6 | 2026-12-15T11:00:00+03:00 | 2026-12-15T13:00:00+03:00',
        '#20 | Домик 2 | 2026-12-20T11:00:00+03:00 | 2026-12-20T13:00:00+03:00',
      ],
    });
    expect(v).not.toHaveProperty('UF_G');
  });

  it('без действующих броней — одиночные поля и список очищаются', () => {
    expect(dealBookingFieldValues(map, [], names, 'Europe/Moscow', now)).toEqual({ UF_ID: '', UF_S: '', UF_E: '', UF_VD: '', UF_VT: '', UF_LIST: [] });
  });

  it('сравнение с ответом crm.deal.get: даты в другом формате/поясе, числа, пустые множественные', () => {
    expect(sameFieldValue('2026-12-15T10:00:00+02:00', '2026-12-15T11:00:00+03:00')).toBe(true);
    expect(sameFieldValue('2026-12-15T00:00:00+03:00', '15.12.2026')).toBe(true);
    expect(sameFieldValue(6060, '6060')).toBe(true);
    expect(sameFieldValue(false, '')).toBe(true);
    expect(sameFieldValue(false, [])).toBe(true);
    expect(sameFieldValue(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameFieldValue(['b', 'a'], ['a', 'b'])).toBe(false);
    expect(sameFieldValue('6060', '')).toBe(false);
  });
});

function setup(o: { records?: ReturnType<typeof rec>[]; deal?: Record<string, unknown> | null; updateFails?: string; savedMap?: Record<string, string>; detected?: Record<string, string> } = {}) {
  const records = o.records ?? [];
  const prisma = {
    bookingRecord: {
      findMany: vi.fn(async ({ where }: { where: { status: string; dealId: number; portalId: string } }) =>
        records.filter((r) => r.status === where.status).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()),
      ),
    },
    resource: { findMany: vi.fn(async () => [{ resourceId: 6, name: 'Баня 6' }]) },
  } as unknown as PrismaService;
  const fieldMap = { get: vi.fn(async () => o.savedMap ?? map), resolved: vi.fn(async () => ({ ...o.detected, ...(o.savedMap ?? map) })) } as unknown as DealFieldMapService;
  const calls: [string, Record<string, unknown>][] = [];
  const client = {
    call: vi.fn(async (method: string, params: Record<string, unknown>) => {
      calls.push([method, params]);
      if (method === 'crm.deal.get') return { result: o.deal === undefined ? { ID: '678' } : o.deal };
      if (method === 'crm.deal.update' && o.updateFails) throw new Bitrix24Error(o.updateFails, 'blocked');
      return { result: true };
    }),
  } as unknown as Bitrix24RestClient;
  const svc = new DealBookingFieldsService(prisma, fieldMap);
  const ctx = { portalId: 'p1', timezone: 'Europe/Moscow', client };
  return { svc, ctx, calls, prisma };
}

describe('DealBookingFieldsService.refresh', () => {
  const active = rec(6060, '2026-12-15T01:00:00Z', '2026-12-15T05:00:00Z');
  const cancelled = rec(6061, '2026-12-12T01:00:00Z', '2026-12-12T05:00:00Z', [6], 'cancelled');

  it('читает только действующие брони портала и сделки, пишет одним crm.deal.update только изменившееся', async () => {
    const t = setup({ records: [active, cancelled], deal: { ID: '678', UF_ID: '6061', UF_S: '2026-12-15T04:00:00+03:00', UF_LIST: false } });
    const w = await t.svc.refresh(t.ctx, 678, now);
    expect(w).toEqual([]);
    expect((t.prisma.bookingRecord.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where).toEqual({ portalId: 'p1', dealId: 678, status: 'active' });
    const updates = t.calls.filter((c) => c[0] === 'crm.deal.update');
    expect(updates).toHaveLength(1);
    expect(updates[0][1]).toEqual({
      id: 678,
      fields: {
        UF_ID: '6060',
        UF_E: '2026-12-15T08:00:00+03:00',
        UF_VD: '15.12.2026',
        UF_VT: '04:00',
        UF_LIST: ['#6060 | Баня 6 | 2026-12-15T04:00:00+03:00 | 2026-12-15T08:00:00+03:00'],
      },
    });
  });

  it('без изменений — не пишет', async () => {
    const t = setup({
      records: [active],
      deal: {
        UF_ID: 6060,
        UF_S: '2026-12-15T04:00:00+03:00',
        UF_E: '2026-12-15T08:00:00+03:00',
        UF_VD: '2026-12-15T00:00:00+03:00',
        UF_VT: '04:00',
        UF_LIST: ['#6060 | Баня 6 | 2026-12-15T04:00:00+03:00 | 2026-12-15T08:00:00+03:00'],
      },
    });
    expect(await t.svc.refresh(t.ctx, 678, now)).toEqual([]);
    expect(t.calls.map((c) => c[0])).toEqual(['crm.deal.get']);
  });

  it('последняя бронь отменена — одиночные поля и список очищаются (множественное — пустой строкой)', async () => {
    const t = setup({ records: [cancelled], deal: { UF_ID: '6061', UF_S: '2026-12-12T04:00:00+03:00', UF_LIST: ['#6061 | …'] } });
    await t.svc.refresh(t.ctx, 678, now);
    expect(t.calls.find((c) => c[0] === 'crm.deal.update')![1]).toEqual({ id: 678, fields: { UF_ID: '', UF_S: '', UF_LIST: '' } });
  });

  it('запись запрещена режимом «только чтение»/песочницей — предупреждение, не исключение', async () => {
    const t = setup({ records: [active], updateFails: 'READ_ONLY_MODE' });
    const w = await t.svc.refresh(t.ctx, 678, now);
    expect(w).toEqual([expect.stringContaining('изменять существующие сделки не разрешено')]);
  });

  it('другая ошибка записи или сделка не найдена — тоже предупреждение', async () => {
    const t = setup({ records: [active], updateFails: 'ACCESS_DENIED' });
    expect(await t.svc.refresh(t.ctx, 678, now)).toEqual([expect.stringContaining('не обновлены')]);
    const gone = setup({ records: [active], deal: null });
    expect(await gone.svc.refresh(gone.ctx, 678, now)).toEqual([expect.stringContaining('сделка не найдена')]);
  });

  it('поля не настроены — ни одного вызова; «Брони сделки» без сопоставления находится по названию', async () => {
    const none = setup({ savedMap: { guests: 'UF_G' } });
    expect(await none.svc.refresh(none.ctx, 678, now)).toEqual([]);
    expect(none.calls).toEqual([]);
    const found = setup({ records: [active], savedMap: {}, detected: { bookingsList: 'UF_CRM_BTX24_BOOKINGS_LIST' } });
    await found.svc.refresh(found.ctx, 678, now);
    expect(found.calls.find((c) => c[0] === 'crm.deal.update')![1]).toEqual({
      id: 678,
      fields: { UF_CRM_BTX24_BOOKINGS_LIST: ['#6060 | Баня 6 | 2026-12-15T04:00:00+03:00 | 2026-12-15T08:00:00+03:00'] },
    });
  });
});
