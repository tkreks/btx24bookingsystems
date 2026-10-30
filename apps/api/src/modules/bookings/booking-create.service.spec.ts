import { BookingCreateService, dateRu, productRow, timeRu, zonedIso } from './booking-create.service.js';
import { detectFieldMap, type DealFieldMapService } from './deal-field-map.service.js';
import type { BookingJournalService } from './booking-journal.service.js';
import type { DealBookingFieldsService } from './deal-booking-fields.service.js';
import type { DealFormService } from './deal-form.service.js';
import type { DealFormField } from '@btx24/shared';
import type { AccessService } from '../access/access.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import type { ActionLogService } from '../audit/action-log.service.js';
import { Bitrix24Error } from '../bitrix24/rest/errors.js';
import { Prisma } from '../../generated/prisma/client.js';

const group = {
  id: 'g1',
  resourceIds: [10, 11],
  dealCategoryId: 0,
  options: {
    bookingTypes: [
      { id: 'programs', title: 'Программы', keywords: ['Алатырь'], dealTypeValue: '86', program: '@keyword', confirmation: [] },
      { id: 'hourly', title: 'Почасовая', keywords: ['Почасовая'], dealTypeValue: '88', program: '', confirmation: [] },
    ],
  } as { bookingTypes: unknown[]; bookingTypeRequired?: boolean },
};
const map = { bookingId: 'UF_ID', bookingStart: 'UF_START', bookingEnd: 'UF_END', visitDateStart: 'UF_VD', visitTimeStart: 'UF_VT', guests: 'UF_G', bookingType: 'UF_TYPE', managerComment: 'UF_C' };

function setup(o: { dealContact?: string | null; failCompensation?: boolean; fail?: string; failCode?: string; can?: boolean; permissions?: string[]; prevOp?: Record<string, unknown>; afterRace?: Record<string, unknown> | null; createDup?: boolean; claimCount?: number; dealProducts?: string[]; formFields?: DealFormField[]; refreshWarnings?: string[] } = {}) {
  const ops: Record<string, unknown>[] = [];
  const prisma = {
    bookingOperation: {
      // Первое чтение — состояние до захвата; повторное (после проигранной гонки) — состояние победителя.
      findUnique: vi.fn().mockResolvedValueOnce(o.prevOp ?? null).mockResolvedValue(o.afterRace ?? null),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const count = o.claimCount ?? 1;
        if (count) Object.assign(ops[0] ?? (ops[0] = { id: 'op1', ...o.prevOp }), data);
        return { count };
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (o.createDup) throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' });
        const r = { id: 'op1', ...data };
        ops.push(r);
        return r;
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(ops[0] ?? (ops[0] = { id: 'op1', ...o.prevOp }), data)),
    },
  } as unknown as PrismaService;
  const access = {
    resolve: vi.fn(async () => ({})),
    pick: vi.fn(() => (o.can === false ? null : { group, permissions: o.permissions ?? ['booking.create', 'deal.create'] })),
  } as unknown as AccessService;
  const journal = { recordCreated: vi.fn(async () => ({})) };
  const fieldMap = { get: vi.fn(async () => map), enumId: vi.fn(async (_p: string, _c: unknown, _f: string, v: string) => (v === 'xml-88' ? '88' : v)) } as unknown as DealFieldMapService;
  const calls: [string, Record<string, unknown>][] = [];
  const call = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    // Проверка клиента сделки — до записей; в списке вызовов саги её не учитываем.
    if (method === 'crm.deal.get') return { result: { ID: String(params.id), CONTACT_ID: o.dealContact === undefined ? '140' : o.dealContact } };
    calls.push([method, params]);
    if (o.failCompensation && method === 'booking.v1.booking.delete') throw new Error('delete failed');
    if (o.fail === method) throw new Bitrix24Error(o.failCode ?? (method === 'booking.v1.booking.add' ? '1018' : 'ERR'), `${method} failed`);
    if (method === 'crm.deal.add') return { result: 900 };
    if (method === 'booking.v1.booking.add') return { result: 555 };
    if (method === 'crm.deal.productrows.get') return { result: (o.dealProducts ?? []).map((n) => ({ PRODUCT_NAME: n })) };
    return { result: true };
  });
  const listAll = vi.fn(async () => [{ NAME: 'Программа «Алатырь» 4 часа' }]);
  const user = { portal: { id: 'p1', timezone: 'Europe/Moscow' }, userId: 7, userName: 'Анна', client: { call, listAll } } as unknown as B24UserContext;
  const dealForm = { createFields: vi.fn(async () => o.formFields ?? []) } as unknown as DealFormService;
  const actions = { user: vi.fn(async () => undefined) };
  const dealBookings = { refresh: vi.fn(async () => o.refreshWarnings ?? []) };
  const svc = new BookingCreateService(
    prisma, access, journal as unknown as BookingJournalService, fieldMap, dealForm, actions as unknown as ActionLogService, undefined,
    dealBookings as unknown as DealBookingFieldsService,
  );
  return { svc, user, calls, journal, ops, actions, prisma, dealBookings };
}

const body = (over: Record<string, unknown> = {}) => ({
  idempotencyKey: 'key-12345678',
  groupId: 'g1',
  kind: 'client',
  resourceIds: [10],
  start: '2020-06-01T11:00:00.000Z',
  end: '2020-06-01T15:00:00.000Z',
  dealId: 678,
  contactId: 140,
  guests: 4,
  comment: 'Именинник',
  products: [{ productId: 31, quantity: 1, price: 45000 }],
  paymentMode: 'prepayment',
  ...over,
});

describe('BookingCreateService', () => {
  it('runs the saga: booking → deal link → client → system fields (type by products) → products → journal', async () => {
    const t = setup();
    const r = await t.svc.create(t.user, body());
    expect(r).toEqual({ bookingId: 555, dealId: 678, bookingType: 'Программы', warnings: [] });
    expect(t.calls.map((c) => c[0])).toEqual([
      'booking.v1.booking.add',
      'booking.v1.booking.externalData.set',
      'booking.v1.booking.client.set',
      'crm.deal.update',
      'crm.deal.productrows.set',
    ]);
    expect(t.calls[0][1]).toMatchObject({ fields: { resourceIds: [10], datePeriod: { from: { timestamp: 1591009200, timezone: 'Europe/Moscow' } } } });
    expect(t.calls[3][1]).toEqual({
      id: 678,
      // Номер и даты брони/визита — не здесь, а пересчётом по журналу (шаг 7).
      fields: { UF_G: 4, UF_TYPE: '86', UF_C: 'Именинник' },
    });
    expect(t.calls[4][1]).toEqual({ id: 678, rows: [{ PRODUCT_ID: 31, PRICE: 45000, QUANTITY: 1, DISCOUNT_TYPE_ID: 2, DISCOUNT_RATE: 0, DISCOUNT_SUM: 0 }] });
    expect(t.journal.recordCreated).toHaveBeenCalledWith('p1', expect.objectContaining({ bookingId: 555, dealId: 678, paymentMode: 'prepayment' }), { kind: 'user', userId: 7, name: 'Анна' });
    expect(t.ops[0]).toMatchObject({ status: 'done', bookingId: 555 });
    // 7. Пересчёт полей броней сделки — после записи брони в журнал, токеном сотрудника.
    expect(t.dealBookings.refresh).toHaveBeenCalledTimes(1);
    expect(t.dealBookings.refresh).toHaveBeenCalledWith({ portalId: 'p1', timezone: 'Europe/Moscow', client: t.user.client }, 678);
    expect(t.dealBookings.refresh.mock.invocationCallOrder[0]).toBeGreaterThan(t.journal.recordCreated.mock.invocationCallOrder[0]);
  });

  it('предупреждения пересчёта полей броней — в warnings, бронь создана; служебная бронь — без пересчёта', async () => {
    const t = setup({ refreshWarnings: ['Поля броней в сделке #678 не обновлены'] });
    expect((await t.svc.create(t.user, body())).warnings).toEqual(['Поля броней в сделке #678 не обновлены']);
    const s = setup();
    await s.svc.create(s.user, body({ kind: 'service', dealId: undefined, products: [] }));
    expect(s.dealBookings.refresh).not.toHaveBeenCalled();
  });

  it('new deal is created in the group funnel first', async () => {
    const t = setup();
    const r = await t.svc.create(t.user, body({ dealId: undefined, newDeal: { title: 'Баня, Иванов', contactId: 140 } }));
    expect(r.dealId).toBe(900);
    expect(t.calls[0]).toEqual(['crm.deal.add', { fields: { TITLE: 'Баня, Иванов', CATEGORY_ID: 0, ASSIGNED_BY_ID: 7, CONTACT_ID: 140 } }]);
  });

  it('у брони всегда есть клиент: сделка без контакта — контакт заявки привязывается к сделке', async () => {
    const t = setup({ dealContact: null });
    const r = await t.svc.create(t.user, body());
    expect(r.warnings).toEqual([]);
    expect(t.calls).toContainEqual(['crm.deal.contact.add', { id: 678, fields: { CONTACT_ID: 140, IS_PRIMARY: 'Y' } }]);
  });

  it('у брони всегда есть клиент: ни у сделки, ни в заявке — 400 до любых записей', async () => {
    const t = setup({ dealContact: null });
    await expect(t.svc.create(t.user, body({ contactId: null }))).rejects.toMatchObject({ status: 400, response: { code: 'CLIENT_REQUIRED' } });
    const n = setup();
    await expect(n.svc.create(n.user, body({ dealId: undefined, contactId: null, newDeal: { title: 'Баня', contactId: null } }))).rejects.toMatchObject({ response: { code: 'CLIENT_REQUIRED' } });
    expect([...t.calls, ...n.calls]).toEqual([]);
    expect([...t.ops, ...n.ops]).toEqual([]);
  });

  it('у сделки уже есть клиент — контакт к ней не добавляется', async () => {
    const t = setup();
    await t.svc.create(t.user, body());
    expect(t.calls.some(([m]) => m === 'crm.deal.contact.add')).toBe(false);
  });

  it('overlap (1018) → 409, nothing to compensate', async () => {
    const t = setup({ fail: 'booking.v1.booking.add' });
    await expect(t.svc.create(t.user, body())).rejects.toMatchObject({ status: 409 });
    expect(t.calls.map((c) => c[0])).toEqual(['booking.v1.booking.add']);
    expect(t.ops[0]).toMatchObject({ status: 'failed' });
  });

  it('failure after the booking exists → booking deleted (slot freed), operation failed', async () => {
    const t = setup({ fail: 'crm.deal.update' });
    await expect(t.svc.create(t.user, body())).rejects.toThrow('crm.deal.update failed');
    expect(t.calls.at(-1)).toEqual(['booking.v1.booking.delete', { id: 555 }]);
    expect(t.journal.recordCreated).not.toHaveBeenCalled();
    expect(t.ops[0]).toMatchObject({ status: 'failed' });
  });

  it('неудавшаяся компенсация видна в журнале как критическое событие', async () => {
    const t = setup({ fail: 'crm.deal.update', failCompensation: true });
    await expect(t.svc.create(t.user, body())).rejects.toThrow('crm.deal.update failed');
    expect(t.ops[0]).toMatchObject({ status: 'failed', bookingId: 555 });
    expect(t.actions.user).toHaveBeenCalledWith(t.user, expect.objectContaining({ action: 'booking.compensation_failed', entityType: 'booking', entityId: 555 }));
  });

  it('повтор с тем же ключом: готово — прежний результат; идёт — 409; сорвалось — выполняется заново', async () => {
    const done = setup({ prevOp: { status: 'done', bookingId: 555, dealId: 678, request: body() } });
    expect(await done.svc.create(done.user, body())).toMatchObject({ bookingId: 555, warnings: [expect.stringContaining('Повтор')] });
    expect(done.calls).toEqual([]);
    const running = setup({ prevOp: { status: 'running', updatedAt: new Date(), request: body() } });
    await expect(running.svc.create(running.user, body())).rejects.toMatchObject({ status: 409 });
    const failed = setup({ prevOp: { status: 'failed', error: 'x', updatedAt: new Date(), dealId: null } });
    expect(await failed.svc.create(failed.user, body())).toMatchObject({ bookingId: 555 });
  });

  it('после сбоя: новая сделка прошлой попытки используется снова, оставшаяся бронь сначала снимается', async () => {
    const t = setup({ prevOp: { status: 'failed', updatedAt: new Date(0), dealId: 900, bookingId: 554 } });
    const r = await t.svc.create(t.user, body({ dealId: undefined, newDeal: { title: 'Баня', contactId: 140 } }));
    expect(r.dealId).toBe(900);
    expect(t.calls[0]).toEqual(['booking.v1.booking.delete', { id: 554 }]);
    expect(t.calls.some(([m]) => m === 'crm.deal.add')).toBe(false);
  });

  describe('гонки идемпотентности', () => {
    it('два первых запроса с одним ключом: проигравший create (P2002), победитель ещё идёт — 409 OPERATION_RUNNING без шагов', async () => {
      const t = setup({ createDup: true, afterRace: { id: 'op1', status: 'running', updatedAt: new Date(), request: body() } });
      await expect(t.svc.create(t.user, body())).rejects.toMatchObject({ status: 409, response: { code: 'OPERATION_RUNNING' } });
      expect(t.calls).toEqual([]);
    });

    it('два первых запроса: победитель уже создал бронь — проигравший возвращает его результат', async () => {
      const t = setup({ createDup: true, afterRace: { id: 'op1', status: 'done', bookingId: 555, dealId: 678, updatedAt: new Date(), request: body() } });
      expect(await t.svc.create(t.user, body())).toMatchObject({ bookingId: 555, dealId: 678, warnings: [expect.stringContaining('Повтор')] });
      expect(t.calls).toEqual([]);
    });

    it('два повтора после сбоя: захват атомарный (status+updatedAt), проигравший не создаёт вторую сделку', async () => {
      const updatedAt = new Date(0);
      const prevOp = { id: 'op1', status: 'failed', updatedAt, dealId: null, bookingId: null };
      const win = setup({ prevOp });
      const nb = body({ dealId: undefined, newDeal: { title: 'Баня', contactId: 140 } });
      await win.svc.create(win.user, nb);
      expect(win.prisma.bookingOperation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'op1', status: 'failed', updatedAt }, data: expect.objectContaining({ status: 'running' }) }),
      );
      expect(win.calls.filter(([m]) => m === 'crm.deal.add')).toHaveLength(1);
      const lose = setup({ prevOp, claimCount: 0, afterRace: { id: 'op1', status: 'running', updatedAt: new Date(), request: nb } });
      await expect(lose.svc.create(lose.user, nb)).rejects.toMatchObject({ status: 409, response: { code: 'OPERATION_RUNNING' } });
      expect(lose.calls).toEqual([]);
    });

    it('проигравший захват, а победитель уже успел снова сорваться — 409 «повторите», шаги не выполняются', async () => {
      const t = setup({ prevOp: { id: 'op1', status: 'failed', updatedAt: new Date(0) }, claimCount: 0, afterRace: { id: 'op1', status: 'failed', updatedAt: new Date() } });
      await expect(t.svc.create(t.user, body())).rejects.toMatchObject({ response: { code: 'OPERATION_RUNNING' } });
      expect(t.calls).toEqual([]);
    });

    it('зависшая заявка: захват по прежнему updatedAt — второй «спасатель» не запускает шаги', async () => {
      const t = setup({ prevOp: { id: 'op1', status: 'running', updatedAt: new Date(0), request: body() }, claimCount: 0, afterRace: { id: 'op1', status: 'running', updatedAt: new Date(), request: body() } });
      await expect(t.svc.create(t.user, body())).rejects.toMatchObject({ response: { code: 'OPERATION_RUNNING' } });
      expect(t.prisma.bookingOperation.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: 'running', updatedAt: new Date(0) }) }));
      expect(t.calls).toEqual([]);
    });

    it('тот же ключ, другие параметры: готово или идёт — 409 IDEMPOTENCY_KEY_REUSED; порядок полей не важен', async () => {
      const done = setup({ prevOp: { status: 'done', bookingId: 555, dealId: 678, request: body() } });
      await expect(done.svc.create(done.user, body({ guests: 5 }))).rejects.toMatchObject({ status: 409, response: { code: 'IDEMPOTENCY_KEY_REUSED' } });
      const running = setup({ prevOp: { status: 'running', updatedAt: new Date(), request: body() } });
      await expect(running.svc.create(running.user, body({ start: '2020-06-01T12:00:00.000Z' }))).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REUSED' } });
      const reordered = Object.fromEntries(Object.entries(body()).reverse());
      const same = setup({ prevOp: { status: 'done', bookingId: 555, dealId: 678, request: reordered } });
      expect(await same.svc.create(same.user, body())).toMatchObject({ bookingId: 555 });
    });

    it('после сбоя повтор с исправленными параметрами разрешён (форма держит один ключ), новые параметры сохраняются', async () => {
      const t = setup({ prevOp: { id: 'op1', status: 'failed', updatedAt: new Date(0), request: body() } });
      expect(await t.svc.create(t.user, body({ guests: 6 }))).toMatchObject({ bookingId: 555 });
      expect(t.prisma.bookingOperation.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ request: expect.objectContaining({ guests: 6 }) }) }));
    });

    it('оставшуюся бронь прошлой попытки снять не удалось — 503, захват отпущен (failed), бронь сохранена в записи', async () => {
      const t = setup({ prevOp: { id: 'op1', status: 'failed', updatedAt: new Date(0), dealId: null, bookingId: 554 }, failCompensation: true });
      await expect(t.svc.create(t.user, body())).rejects.toMatchObject({ status: 503, response: { code: 'BITRIX_UNAVAILABLE' } });
      expect(t.ops[0]).toMatchObject({ status: 'failed', bookingId: 554 });
      expect(t.calls.map((c) => c[0])).toEqual(['booking.v1.booking.delete']);
    });
  });

  it('портал не ответил (лимит) — 503 «повторите», бронь снята', async () => {
    const t = setup({ fail: 'crm.deal.update', failCode: 'QUERY_LIMIT_EXCEEDED' });
    await expect(t.svc.create(t.user, body({ bookingTypeId: 'hourly' }))).rejects.toMatchObject({ status: 503, response: { code: 'BITRIX_UNAVAILABLE' } });
    expect(t.calls.map((c) => c[0])).toContain('booking.v1.booking.delete');
  });

  it('validates: rights, group resources, deal required, end after start', async () => {
    await expect(setup({ can: false }).svc.create(setup().user, body())).rejects.toMatchObject({ status: 403 });
    const t = setup();
    await expect(t.svc.create(t.user, body({ resourceIds: [99] }))).rejects.toMatchObject({ status: 400 });
    await expect(t.svc.create(t.user, body({ dealId: undefined }))).rejects.toMatchObject({ status: 400 });
    await expect(t.svc.create(t.user, body({ end: '2020-06-01T10:00:00.000Z' }))).rejects.toMatchObject({ status: 400 });
    expect(await t.svc.create(t.user, body({ kind: 'service', dealId: undefined, products: [] }))).toMatchObject({ dealId: null });
  });
});

describe('BookingCreateService: права и режим «создавать новые»', () => {
  it('free and postpay need booking.create and deal.create; a new deal needs deal.create', async () => {
    const t = setup({ permissions: ['booking.create'] });
    await expect(t.svc.create(t.user, body({ paymentMode: 'free' }))).rejects.toMatchObject({ status: 403 });
    await expect(t.svc.create(t.user, body({ paymentMode: 'postpay', idempotencyKey: 'key-22222222' }))).rejects.toMatchObject({ status: 403 });
    await expect(t.svc.create(t.user, body({ dealId: undefined, newDeal: { title: 'x' }, idempotencyKey: 'key-33333333' }))).rejects.toMatchObject({ status: 403 });
    expect(t.calls).toEqual([]);
    expect(await t.svc.create(t.user, body({ paymentMode: 'cash_on_site', idempotencyKey: 'key-44444444' }))).toMatchObject({ bookingId: 555 });
    const full = setup();
    expect(await full.svc.create(full.user, body({ paymentMode: 'free' }))).toMatchObject({ bookingId: 555 });
  });

  it('existing deal closed for writes → booking kept, warning instead of failure', async () => {
    const t = setup({ fail: 'crm.deal.update', failCode: 'READ_ONLY_MODE' });
    const r = await t.svc.create(t.user, body());
    expect(r.bookingId).toBe(555);
    expect(r.warnings).toEqual([expect.stringContaining('Поля сделки #678 не заполнены')]);
    expect(t.calls.map((c) => c[0])).not.toContain('booking.v1.booking.delete');
  });

  it('a new deal refusing writes is a real failure (compensated)', async () => {
    const t = setup({ fail: 'crm.deal.update', failCode: 'READ_ONLY_MODE' });
    await expect(t.svc.create(t.user, body({ dealId: undefined, newDeal: { title: 'x' } }))).rejects.toThrow('crm.deal.update failed');
    expect(t.calls.at(-1)).toEqual(['booking.v1.booking.delete', { id: 555 }]);
  });
});

describe('date helpers and field detection', () => {
  it('formats in portal time zone', () => {
    const d = new Date('2026-10-23T11:00:00Z');
    expect(zonedIso(d, 'Europe/Moscow')).toBe('2026-10-23T14:00:00+03:00');
    expect(zonedIso(d, 'UTC')).toBe('2026-10-23T11:00:00+00:00');
    expect(dateRu(d, 'Europe/Moscow')).toBe('23.10.2026');
    expect(timeRu(d, 'Europe/Moscow')).toBe('14:00');
  });

  it('detects system deal fields by labels', () => {
    expect(
      detectFieldMap({
        UF_CRM_1: { listLabel: 'ID Бронирования' },
        UF_CRM_2: { formLabel: 'Дата начала визита ' },
        UF_CRM_3: { title: 'Количество  гостей' },
        TITLE: { listLabel: 'Тип бронирования' },
      }),
    ).toEqual({ bookingId: 'UF_CRM_1', visitDateStart: 'UF_CRM_2', guests: 'UF_CRM_3' });
  });
});

describe('BookingCreateService: тип брони', () => {
  const dealUpdate = (t: ReturnType<typeof setup>) => t.calls.find((c) => c[0] === 'crm.deal.update')![1] as { fields: Record<string, unknown> };

  it('by the deal products when the manager did not choose (как БП 270)', async () => {
    const t = setup({ dealProducts: ['Баня. Почасовая аренда'] });
    const r = await t.svc.create(t.user, body({ products: undefined }));
    expect(r.bookingType).toBe('Почасовая');
    expect(dealUpdate(t).fields.UF_TYPE).toBe('88');
  });

  it('the manager’s choice wins over products', async () => {
    const t = setup({ dealProducts: ['Баня. Почасовая аренда'] });
    const r = await t.svc.create(t.user, body({ products: undefined, bookingTypeId: 'programs' }));
    expect(r.bookingType).toBe('Программы');
    expect(dealUpdate(t).fields.UF_TYPE).toBe('86');
    await expect(t.svc.create(t.user, body({ idempotencyKey: 'key-99999999', bookingTypeId: 'nope' }))).rejects.toMatchObject({ status: 400 });
  });

  it('required in the group: not chosen and not found by products → 400 before anything is created', async () => {
    group.options.bookingTypeRequired = true;
    try {
      const t = setup({ dealProducts: ['Что-то другое'] });
      await expect(t.svc.create(t.user, body({ products: undefined }))).rejects.toMatchObject({ status: 400 });
      expect(t.calls.map((c) => c[0])).toEqual(['crm.deal.productrows.get']);
      // новая сделка без товаров — тип нужно выбрать
      await expect(t.svc.create(t.user, body({ idempotencyKey: 'key-88888888', dealId: undefined, newDeal: { title: 'x' }, products: undefined }))).rejects.toMatchObject({ status: 400 });
      expect(await t.svc.create(t.user, body({ idempotencyKey: 'key-77777777', dealId: undefined, newDeal: { title: 'x' }, products: undefined, bookingTypeId: 'hourly' }))).toMatchObject({ bookingType: 'Почасовая' });
      // служебная бронь — без типа
      expect(await t.svc.create(t.user, body({ idempotencyKey: 'key-66666666', kind: 'service', dealId: undefined, products: [] }))).toMatchObject({ bookingType: null });
    } finally {
      delete group.options.bookingTypeRequired;
    }
  });
});


describe('DealFieldMapService.enumId', () => {
  it('BP variant code (XML_ID) or title → variant ID; unknown → null', async () => {
    const { DealFieldMapService } = await import('./deal-field-map.service.js');
    const svc = new DealFieldMapService({} as never);
    const call = vi.fn(async () => ({ result: [{ LIST: [{ ID: '86', XML_ID: '3af19224', VALUE: 'Программа' }, { ID: '88', XML_ID: '9829f9e5', VALUE: 'Почасовка' }] }] }));
    const client = { call } as never;
    expect(await svc.enumId('p1', client, 'UF_T', '3af19224')).toBe('86');
    expect(await svc.enumId('p1', client, 'UF_T', '88')).toBe('88');
    expect(await svc.enumId('p1', client, 'UF_T', 'Почасовка')).toBe('88');
    expect(await svc.enumId('p1', client, 'UF_T', 'нет')).toBeNull();
    expect(call).toHaveBeenCalledTimes(1); // кэш
  });
});

describe('BookingCreateService — поля сделки группы', () => {
  const field = (over: Partial<DealFormField>): DealFormField => ({
    code: 'UF_X', label: 'Поле', kind: 'string', required: false, readOnly: false, inlineNext: false,
    showCreate: true, showView: true, role: null, value: '', display: '', ...over,
  });
  const formFields = [
    field({ code: 'UF_KIND', label: 'Тип сделки', kind: 'enum', items: [{ id: '72', value: 'Посещение' }] }),
    field({ code: 'UF_SUM', label: 'Предоплата', kind: 'money', required: true }),
  ];

  it('пишет поля формы в сделку вместе с системными (системные важнее)', async () => {
    const { svc, user, calls } = setup({ formFields });
    await svc.create(user, body({ dealFields: { UF_KIND: '72', UF_SUM: '1500' }, bookingTypeId: 'hourly' }));
    const upd = calls.find(([m]) => m === 'crm.deal.update')![1] as { fields: Record<string, unknown> };
    expect(upd.fields).toMatchObject({ UF_KIND: '72', UF_SUM: '1500|RUB', UF_G: 4 });
  });

  it('поле формы с кодом номера/дат брони не пишется формой: его ведёт пересчёт', async () => {
    const { svc, user, calls } = setup({ formFields: [...formFields, field({ code: 'UF_START', label: 'Начало', kind: 'string' })] });
    await svc.create(user, body({ dealFields: { UF_KIND: '72', UF_SUM: '1500', UF_START: 'вручную' }, bookingTypeId: 'hourly' }));
    const upd = calls.find(([m]) => m === 'crm.deal.update')![1] as { fields: Record<string, unknown> };
    expect(upd.fields).not.toHaveProperty('UF_START');
    expect(upd.fields).not.toHaveProperty('UF_ID');
  });

  it('обязательное поле пустое — 400 до записей в Битрикс24', async () => {
    const { svc, user, calls } = setup({ formFields });
    await expect(svc.create(user, body({ dealFields: { UF_KIND: '72' }, bookingTypeId: 'hourly' }))).rejects.toMatchObject({
      response: { code: 'INVALID_DEAL_FIELDS', message: 'Заполните поле «Предоплата»' },
    });
    expect(calls.filter(([m]) => m !== 'crm.deal.productrows.get')).toEqual([]);
  });

  it('чужое поле — 400', async () => {
    const { svc, user } = setup({ formFields });
    await expect(svc.create(user, body({ dealFields: { UF_SUM: '1', STAGE_ID: 'WON' }, bookingTypeId: 'hourly' }))).rejects.toMatchObject({
      response: { code: 'INVALID_DEAL_FIELDS' },
    });
  });
});

describe('productRow — скидки товаров как в Битрикс24', () => {
  it('процент: итоговая цена и скидка на единицу', () => {
    expect(productRow({ productId: 1, quantity: 2, price: 5000, discountType: 'percent', discount: 10 })).toEqual({
      PRODUCT_ID: 1, QUANTITY: 2, PRICE: 4500, DISCOUNT_TYPE_ID: 2, DISCOUNT_RATE: 10, DISCOUNT_SUM: 500,
    });
  });
  it('сумма: скидка на единицу, процент для справки; не ниже нуля', () => {
    expect(productRow({ productId: 1, quantity: 1, price: 1500, discountType: 'sum', discount: 300 })).toEqual({
      PRODUCT_ID: 1, QUANTITY: 1, PRICE: 1200, DISCOUNT_TYPE_ID: 1, DISCOUNT_RATE: 20, DISCOUNT_SUM: 300,
    });
    expect(productRow({ productId: 1, quantity: 1, price: 100, discountType: 'sum', discount: 500 }).PRICE).toBe(0);
  });
});
