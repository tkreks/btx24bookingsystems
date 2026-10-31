import type { PaymentRequest } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { AccessService } from '../access/access.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import type { DealFieldMapService } from '../bookings/deal-field-map.service.js';
import { PaymentFlow } from './payment-flow.js';
import { MessageContextService } from '../bookings/message-context.service.js';
import { PaymentsService } from './payments.service.js';
import { resetLineHealthCache } from '../openlines/line-health.js';
import type { BookingJournalService } from '../bookings/booking-journal.service.js';

const options = {
  payments: {
    prepayment: { stageId: 'UC_DIZN23', moveStage: true, templateId: '' },
    surcharge: { stageId: '', moveStage: false, templateId: '' },
    timeoutMinutes: 90,
    successStageId: '',
    failStageId: '',
    successTemplateId: '',
    failTemplateId: '',
    prepaymentPercent: 50,
    invoice: { categoryId: 2, prepaymentStageId: 'DT31_2:N', surchargeStageId: 'DT31_2:S', linkField: 'ufCrmLink', fields: { ufCrmType: 78 } },
  },
};

type Grp = { group: { id: string; name: string; dealCategoryId: number; options: unknown; resourceIds?: number[] }; permissions: string[] };
function setup(
  o: {
    permissions?: string[];
    /** Поле «Тип сделки» сделки (74 — покупка сертификата). */
    dealType?: string;
    active?: boolean;
    prev?: Partial<PaymentRequest>;
    link?: string;
    bookings?: number[];
    pastBooking?: number;
    category?: string;
    groups?: Grp[];
    bookingGroup?: string;
    bookingResources?: number[];
    template?: { id: string; name: string; steps: { text: string; fileIds: string[] }[] };
    /** Файлы портала p1 (StoredFile). */
    files?: { id: string; name: string; mime: string; size: number; ownerUserId: number }[];
    /** crm.contact.get падает (нет доступа к контакту). */
    contactDenied?: boolean;
  } = {},
) {
  const calls: [string, Record<string, unknown>][] = [];
  const call = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    calls.push([method, params]);
    if (method === 'crm.deal.get')
      return { result: { ID: '678', TITLE: 'Баня на субботу', CURRENCY_ID: 'RUB', CATEGORY_ID: o.category ?? '0', CONTACT_ID: '140', ASSIGNED_BY_ID: '236', OPPORTUNITY: '90000', UF_PRE: '', STAGE_SEMANTIC_ID: 'P', UF_TYPE: o.dealType ?? '72' } };
    if (method === 'crm.contact.get') {
      if (o.contactDenied) throw new Error('ACCESS_DENIED');
      return { result: { ID: '140', NAME: 'Анна', LAST_NAME: 'Петрова' } };
    }
    if (method === 'crm.item.add') return { result: { item: { id: 6001 } } };
    if (method === 'crm.item.get') return { result: { item: { id: 6001, ufCrmLink: o.link ?? '' } } };
    if (method === 'imopenlines.crm.chat.get') return { result: [{ CHAT_ID: '3301' }] };
    if (method === 'imopenlines.dialog.get') return { result: { entity_data_2: 'LEAD|0|COMPANY|0|CONTACT|140|DEAL|678' } };
    if (method === 'crm.status.list')
      return { result: [{ STATUS_ID: 'DT31_2:N', NAME: 'Внесение предоплаты', SEMANTICS: null }, { STATUS_ID: 'DT31_2:P', NAME: 'Оплачен', SEMANTICS: 'S' }, { STATUS_ID: 'DT31_2:D', NAME: 'Не оплачен', SEMANTICS: 'F' }] };
    return { result: {} };
  });
  const listAll = vi.fn(async () => [
    { id: 6003, title: 'Счёт БП', opportunity: 25000, currencyId: 'RUB', stageId: 'DT31_2:N', categoryId: 2, createdTime: '2026-10-22T10:00:00+03:00' },
    { id: 6002, title: 'Оплаченный', opportunity: 10000, currencyId: 'RUB', stageId: 'DT31_2:P', categoryId: 2, createdTime: '2026-10-21T10:00:00+03:00' },
    { id: 6001, title: 'Приложения', opportunity: 45000, currencyId: 'RUB', stageId: 'DT31_2:N', categoryId: 2, createdTime: '2026-10-20T10:00:00+03:00' },
  ]);
  let row: PaymentRequest | null = null;
  const prisma = {
    paymentRequest: {
      findUnique: vi.fn(async () => (o.prev ? ({ id: 'old', amount: 1, warnings: [], createdAt: new Date(), status: 'sent', ...o.prev } as PaymentRequest) : null)),
      findFirst: vi.fn(async () => (o.active ? { id: 'a' } : null)),
      findMany: vi.fn(async () => [
        { id: 'r1', dealId: 678, kind: 'prepayment', amount: 45000, invoiceId: 6001, status: 'sent', deadlineAt: new Date('2026-10-22T12:00:00Z'), messageSentAt: new Date(), createdAt: new Date(), warnings: [] },
        { id: 'r0', dealId: 678, kind: 'prepayment', amount: 45000, invoiceId: null, status: 'failed', error: 'x', createdAt: new Date(), warnings: [] },
      ]),
      create: vi.fn(async ({ data }: { data: Partial<PaymentRequest> }) => (row = { id: 'q1', status: 'link_pending', createdAt: new Date(), invoiceId: null, link: null, deadlineAt: null, messageSentAt: null, error: null, ...data } as PaymentRequest)),
      update: vi.fn(async ({ data }: { data: Partial<PaymentRequest> }) => (row = { ...row!, ...data } as PaymentRequest)),
    },
    workGroup: { findUnique: vi.fn(async () => ({ options })) },
    bookingRecord: {
      findUnique: vi.fn(async () => (o.bookingGroup || o.bookingResources ? { groupId: o.bookingGroup ?? null, resourceIds: o.bookingResources ?? [] } : null)),
      // Прошедшая бронь сделки (для подсказки «уже прошла»).
      findFirst: vi.fn(async () => (o.pastBooking ? { bookingId: o.pastBooking, startsAt: new Date(Date.now() - 86_400_000), endsAt: new Date(Date.now() - 82_800_000), resourceIds: [2] } : null)),
      findMany: vi.fn(async () =>
        (o.bookings ?? [5918]).map((id, i) => ({ bookingId: id, startsAt: new Date(Date.now() + (i + 1) * 86_400_000), endsAt: new Date(Date.now() + (i + 1) * 86_400_000 + 4 * 3_600_000), resourceIds: [2] })),
      ),
    },
    resource: { findMany: vi.fn(async () => [{ resourceId: 2, name: 'Баня 2' }]) },
    appCreatedEntity: { findUnique: vi.fn(async () => ({})), upsert: vi.fn() },
    messageTemplate: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; portalId: string } }) => (o.template?.id === where.id && where.portalId === 'p1' ? o.template : null)),
      findMany: vi.fn(async () => (o.template ? [o.template] : [])),
    },
    storedFile: {
      findMany: vi.fn(async ({ where }: { where: { portalId: string; id: { in: string[] } } }) =>
        (o.files ?? [{ id: 'f1', name: 'прайс.pdf', mime: 'application/pdf', size: 1, ownerUserId: 1 }])
          .filter((f) => where.portalId === 'p1' && where.id.in.includes(f.id))
          .map((f) => ({ ...f, data: Buffer.from('x') })),
      ),
    },
  } as unknown as PrismaService;
  const group = { group: { id: 'g1', name: 'Бани', dealCategoryId: 0, options, resourceIds: [2, 14] }, permissions: o.permissions ?? ['payment.send'] };
  const access = { resolve: vi.fn(async () => ({ groups: [group, ...(o.groups ?? [])] })) } as unknown as AccessService;
  const fieldMap = {
    get: vi.fn(async () => ({ prepayment: 'UF_PRE', prepaymentInvoiceId: 'UF_INV', prepaymentLink: 'UF_LINK' })),
    // Тип сделки «Покупка сертификата» — вариант 74 поля UF_TYPE.
    outcome: vi.fn(async () => ({ dealType: 'UF_TYPE', certificateTypeId: '74' })),
  } as unknown as DealFieldMapService;
  const flow = new PaymentFlow(prisma, { find: vi.fn() } as unknown as BookingJournalService, fieldMap, new MessageContextService(prisma, fieldMap));
  flow.sendGapMs = 0;
  const svc = new PaymentsService(prisma, access, fieldMap, flow);
  svc.sleep = async () => {};
  const user = { portal: { id: 'p1', timezone: 'Europe/Moscow' }, userId: 242, userName: 'Тест', client: { call, listAll } } as unknown as B24UserContext;
  return { svc, user, calls, prisma };
}

const body = (over: Record<string, unknown> = {}) => ({ idempotencyKey: 'pay-12345678', dealId: 678, kind: 'prepayment', ...over });

describe('PaymentsService', () => {
  it('preview: 50% of the deal, group by the deal funnel', async () => {
    const t = setup();
    const p = await t.svc.preview(t.user, 678, 'prepayment');
    expect(p).toMatchObject({ groupName: 'Бани', amount: 45000, source: 'percent', timeoutMinutes: 90, problems: [] });
  });

  it('creates the invoice of the deal, writes its ID and payment stage to the deal, sends the link when ready', async () => {
    const t = setup({ link: 'https://pay.example/x' });
    const r = await t.svc.create(t.user, body());
    expect(t.calls.find((c) => c[0] === 'crm.item.add')![1]).toEqual({
      entityTypeId: 31,
      fields: expect.objectContaining({ categoryId: 2, stageId: 'DT31_2:N', opportunity: 45000, parentId2: 678, contactId: 140, assignedById: 236, ufCrmType: 78 }),
    });
    expect(t.calls.find((c) => c[0] === 'crm.deal.update')![1]).toEqual({ id: 678, fields: { UF_INV: 6001, STAGE_ID: 'UC_DIZN23' } });
    expect(r).toMatchObject({ status: 'sent', invoiceId: 6001, amount: 45000, messageSent: true });
  });

  it('встройка сделки: основание в названии и комментарии счёта, свой текст и срок пишутся в заявку', async () => {
    const t = setup();
    await t.svc.create(t.user, body({ amount: 3000, purpose: 'Аренда мангала', timeoutHours: 3, message: 'Просим Вам произвести оплату {{СсылкаНаОплату}}' }));
    const f = t.calls.find((c) => c[0] === 'crm.item.add')![1].fields as { title: string; comments: string };
    expect(f.title).toMatch(/^Аренда мангала по сделке #678/);
    expect(f.comments).toContain('Основание: Аренда мангала');
    expect(t.prisma.paymentRequest.create).toHaveBeenCalledWith({ data: expect.objectContaining({ purpose: 'Аренда мангала', timeoutMinutes: 180, message: 'Просим Вам произвести оплату {{СсылкаНаОплату}}' }) });
    await expect(t.svc.create(t.user, body({ timeoutHours: 25 }))).rejects.toMatchObject({ status: 400 });
  });

  it('произвольная: без брони и расчёта, несколько сразу, без поля счёта и стадии сделки', async () => {
    const t = setup({ active: true });
    const p = await t.svc.preview(t.user, 678, 'custom');
    expect(p).toMatchObject({ kind: 'custom', amount: null, requireBooking: false, bookingMissing: false, bookingId: null, message: 'Просим Вам произвести оплату {{СсылкаНаОплату}}' });
    expect(p.problems).toEqual([]);
    await expect(t.svc.create(t.user, body({ kind: 'custom', amount: 1500 }))).rejects.toMatchObject({ status: 400 });
    await t.svc.create(t.user, body({ kind: 'custom', amount: 1500, purpose: 'Аренда инвентаря', timeoutHours: 2 }));
    expect((t.calls.find((c) => c[0] === 'crm.item.add')![1].fields as { title: string }).title).toBe('Аренда инвентаря по сделке #678');
    expect(t.calls.some((c) => c[0] === 'crm.deal.update')).toBe(false);
    expect(t.prisma.paymentRequest.create).toHaveBeenCalledWith({ data: expect.objectContaining({ kind: 'custom', bookingId: null, timeoutMinutes: 120 }) });
  });

  it('link not ready yet → stays pending for the worker', async () => {
    const t = setup();
    expect(await t.svc.create(t.user, body({ amount: 30000 }))).toMatchObject({ status: 'link_pending', amount: 30000 });
  });

  it('needs payment.send; refuses a second active invoice; repeat returns the first', async () => {
    await expect(setup({ permissions: [] }).svc.create(setup().user, body())).rejects.toMatchObject({ status: 400 });
    const a = setup({ active: true });
    await expect(a.svc.create(a.user, body())).rejects.toMatchObject({ status: 409 });
    const r = setup({ prev: { invoiceId: 6000 } });
    expect(await r.svc.create(r.user, body())).toMatchObject({ id: 'old', invoiceId: 6000 });
    expect(r.calls).toEqual([]);
  });

  it('lists all deal invoices with stage names; in work — open ones and app requests awaiting payment', async () => {
    const { invoiceInWork } = await import('@btx24/shared');
    const t = setup();
    const r = await t.svc.invoices(t.user, 678);
    expect(r.invoices.map((i) => [i.invoiceId, i.stageName, i.state, i.request?.status ?? null])).toEqual([
      [6003, 'Внесение предоплаты', 'open', null],
      [6002, 'Оплачен', 'paid', null],
      [6001, 'Внесение предоплаты', 'open', 'sent'],
      [0, '', 'failed', 'failed'],
    ]);
    expect(r.invoices.filter(invoiceInWork).map((i) => i.invoiceId)).toEqual([6003, 6001]);
    expect(r.invoices[2].request?.deadline).toBe('2026-10-22T12:00:00.000Z');
  });

  it('client invoices: all deals of the contact; awaiting payment and paid until the booking ends', async () => {
    const t = setup();
    (t.user.client as unknown as { listAll: unknown }).listAll = vi.fn(async (method: string) =>
      method === 'crm.deal.list'
        ? [{ ID: '700', TITLE: 'Домик' }, { ID: '678', TITLE: 'Баня' }]
        : [
            { id: 7004, title: 'Не оплачен', opportunity: 5000, stageId: 'DT31_2:D', categoryId: 2, createdTime: '2026-10-23T10:00:00+03:00', parentId2: 700 },
            { id: 7003, title: 'Счёт домика', opportunity: 15000, stageId: 'DT31_2:N', categoryId: 2, createdTime: '2026-10-22T11:00:00+03:00', parentId2: 700 },
            { id: 6002, title: 'Оплаченный', opportunity: 10000, stageId: 'DT31_2:P', categoryId: 2, createdTime: '2026-10-21T10:00:00+03:00', parentId2: 678 },
            { id: 7001, title: 'Оплачен, бронь прошла', opportunity: 9000, stageId: 'DT31_2:P', categoryId: 2, createdTime: '2026-10-20T10:00:00+03:00', parentId2: 700 },
            { id: 6001, title: 'Приложения', opportunity: 45000, stageId: 'DT31_2:N', categoryId: 2, createdTime: '2026-10-20T10:00:00+03:00', parentId2: 678 },
          ],
    );
    (t.prisma.bookingRecord as unknown as { findMany: unknown }).findMany = vi.fn(async () => [
      { bookingId: 5918, dealId: 678, startsAt: new Date('2026-11-02T10:00:00Z'), endsAt: new Date('2026-11-02T14:00:00Z') },
    ]);
    const r = await t.svc.clientInvoices(t.user, 678);
    // Активные сверху: ждущие оплаты, затем оплаченные с действующей бронью; архив (проигран, бронь прошла) внизу.
    expect(r.invoices.map((i) => [i.invoiceId, i.status, i.archived, i.thisDeal, i.dealTitle, i.deadline])).toEqual([
      [7003, 'waiting', false, false, 'Домик', null],
      [6001, 'waiting', false, true, 'Баня', '2026-10-22T12:00:00.000Z'],
      [6002, 'paid', false, true, 'Баня', null],
      [7004, 'lost', true, false, 'Домик', null],
      [7001, 'paid', true, false, 'Домик', null],
    ]);
    expect(r.invoices.find((i) => i.invoiceId === 6001)).toMatchObject({ requestId: 'r1', booking: { bookingId: 5918 } });
    expect(r.invoices.find((i) => i.invoiceId === 7001)?.booking).toBeNull();
  });

  it('no working open line chat: preview warns, the link message is not sent', async () => {
    resetLineHealthCache();
    const t = setup({ link: 'https://pay.example/x' });
    const client = t.user.client as unknown as { call: (m: string, p?: Record<string, unknown>) => Promise<unknown> };
    const orig = client.call;
    client.call = vi.fn(async (m: string, p: Record<string, unknown> = {}) => {
      if (m === 'imopenlines.dialog.get') return { result: { entity_id: 'wz_telegram_x|8|3301|1', entity_data_2: 'LEAD|0|COMPANY|0|CONTACT|140|DEAL|678' } };
      if (m === 'imopenlines.config.list.get') return { result: [{ ID: '8', LINE_NAME: 'WAZZUP - Telegram', ACTIVE: 'Y' }] };
      if (m === 'imconnector.status') return { result: { CONFIGURED: false, STATUS: false, ERROR: false } };
      return orig(m, p);
    });
    const p = await t.svc.preview(t.user, 678, 'prepayment');
    expect(p.chatProblem).toContain('создайте работающий чат с клиентом');
    const r = await t.svc.create(t.user, body());
    expect(r.messageSent).toBe(false);
    expect(r.warnings.join(' ')).toContain('канал линии «WAZZUP - Telegram» не подключён');
    expect(t.calls.some(([m]) => m === 'imopenlines.crm.message.add' || m === 'im.message.add')).toBe(false);
    resetLineHealthCache();
  });

  it('links the invoice to the nearest booking of the deal; foreign booking refused', async () => {
    const t = setup({ link: 'https://pay.example/x', bookings: [5918, 5920] });
    const p = await t.svc.preview(t.user, 678, 'prepayment');
    expect(p).toMatchObject({ requireBooking: true, bookingMissing: false, bookingId: 5918, bookings: [{ bookingId: 5918, resources: ['Баня 2'] }, { bookingId: 5920 }] });
    expect(await t.svc.create(t.user, body())).toMatchObject({ bookingId: 5918 });
    await expect(t.svc.create(t.user, body({ idempotencyKey: 'pay-87654321', bookingId: 1 }))).rejects.toMatchObject({ status: 400 });
  });

  it('«Требовать бронь перед оплатой»: no booking → «Создайте бронирование…»; switched off → allowed', async () => {
    const t = setup({ bookings: [] });
    const p = await t.svc.preview(t.user, 678, 'prepayment');
    expect(p.bookingMissing).toBe(true);
    expect(p.problems).toContain('Создайте бронирование, а потом переходите к отправке оплаты');
    expect(p.pastBooking).toBeNull();
    // Бронь есть, но уже прошла — подсказка, почему её нет в списке.
    expect((await setup({ bookings: [], pastBooking: 5932 }).svc.preview(t.user, 678, 'prepayment')).pastBooking).toMatchObject({ bookingId: 5932 });
    await expect(t.svc.create(t.user, body())).rejects.toMatchObject({ status: 400 });
    (options.payments as { requireBooking?: boolean }).requireBooking = false;
    try {
      const off = setup({ bookings: [] });
      expect(await off.svc.create(off.user, body())).toMatchObject({ bookingId: null, invoiceId: 6001 });
    } finally {
      delete (options.payments as { requireBooking?: boolean }).requireBooking;
    }
  });

  it('покупка сертификата: ссылка на весь номинал (сумма сделки), брони не нужно', async () => {
    const t = setup({ bookings: [], dealType: '74' });
    const p = await t.svc.preview(t.user, 678, 'prepayment');
    expect(p).toMatchObject({ amount: 90000, source: 'certificate', bookingMissing: false, requireBooking: false });
    expect(p.problems).not.toContain('Создайте бронирование, а потом переходите к отправке оплаты');
  });

  it('deal options: client deals in work, newest first by creation date', async () => {
    const t = setup();
    (t.user.client as unknown as { listAll: ReturnType<typeof vi.fn> }).listAll = vi.fn(async () => [
      { ID: '600', TITLE: 'Старая', DATE_CREATE: '2026-09-01T10:00:00+03:00', CATEGORY_ID: '0' },
      { ID: '700', TITLE: 'Новая', DATE_CREATE: '2026-10-20T10:00:00+03:00', CATEGORY_ID: '14' },
    ]);
    const r = await t.svc.dealOptions(t.user, 678);
    expect(r.defaultDealId).toBe(700);
    expect(r.deals.map((d) => d.id)).toEqual([700, 600]);
  });

  const houses = (id: string, name: string, extra: Record<string, unknown> = {}): Grp => ({
    group: {
      id,
      name,
      dealCategoryId: 14,
      options: { payments: { ...options.payments, prepaymentPercent: 100, prepayment: { stageId: 'C14:PREPAYMENT_INVOIC', moveStage: true, templateId: '' }, ...extra } },
    },
    permissions: ['payment.send'],
  });

  it('group of the booking wins over the deal funnel; the foreign-funnel stage is not applied', async () => {
    // Сделка в воронке домиков (14), бронь создана в группе «Бани» (воронка 0).
    const t = setup({ category: '14', bookingGroup: 'g1', groups: [houses('h1', 'Домики'), houses('h2', 'Беседки')], link: 'https://pay.example/x' });
    const p = await t.svc.preview(t.user, 678, 'prepayment');
    expect(p).toMatchObject({ groupId: 'g1', groupName: 'Бани', amount: 45000 });
    expect(p.groupOptions.map((g) => g.name)).toEqual(['Бани', 'Домики', 'Беседки']);
    const r = await t.svc.create(t.user, body({ groupId: 'g1' }));
    expect(t.calls.find((c) => c[0] === 'crm.deal.update')![1]).toEqual({ id: 678, fields: { UF_INV: 6001 } });
    expect(r.warnings.join(' ')).toContain('из другой воронки');
  });

  it('group of the booking is the group of its resource, whatever the journal says', async () => {
    // Журнал помнит «Домики», но ресурс брони (Теремок, 14) состоит в «Банях».
    const t = setup({ category: '14', bookingGroup: 'h1', bookingResources: [14], groups: [houses('h1', 'Домики')] });
    expect(await t.svc.preview(t.user, 678, 'prepayment')).toMatchObject({ groupId: 'g1', groupName: 'Бани' });
  });

  it('several groups on one funnel: the chosen one is used', async () => {
    const t = setup({ category: '14', groups: [houses('h1', 'Домики'), houses('h2', 'Беседки')] });
    expect((await t.svc.preview(t.user, 678, 'prepayment')).groupName).toBe('Домики');
    expect((await t.svc.preview(t.user, 678, 'prepayment', 'h2')).groupName).toBe('Беседки');
    expect((await t.svc.preview(t.user, 678, 'prepayment', 'g1')).groupId).toBeNull(); // «Бани» — не воронка сделки и не группа брони
  });

  it.each(['prepayment', 'surcharge'] as const)('sends system %s template: ordered texts and attachments', async (kind) => {
    const template = { id: 'tp1', name: 'Предоплата бани', steps: [{ text: 'Ссылка: {link}', fileIds: [] }, { text: 'Правила', fileIds: ['f1'] }] };
    const t = setup({ link: 'https://pay.example/x', template, groups: [] });
    (options.payments as Record<string, unknown>)[`${kind}TemplateId`] = 'tp1';
    try {
      const p = await t.svc.preview(t.user, 678, kind);
      expect(p.templateName).toBe('Предоплата бани');
      await t.svc.create(t.user, body({ kind, amount: 25000 }));
      const sent = t.calls.filter((c) => c[0] === 'imopenlines.crm.message.add').map((c) => c[1].MESSAGE);
      expect(sent).toEqual(['Ссылка: https://pay.example/x', 'Правила']);
      expect(t.calls.find((c) => c[0] === 'im.v2.File.upload')![1]).toMatchObject({ dialogId: 'chat3301', fields: { name: 'прайс.pdf' } });
    } finally {
      delete (options.payments as Record<string, unknown>)[`${kind}TemplateId`];
    }
  });
  describe('отправка выставленного счёта и ожидающие оплату', () => {
    const baseReq = (over: Partial<PaymentRequest> = {}) =>
      ({
        id: 'rq1',
        portalId: 'p1',
        dealId: 678,
        bookingId: null,
        groupId: 'g1',
        kind: 'prepayment',
        amount: 45000,
        invoiceId: 6001,
        link: 'https://pay.example/x',
        status: 'sent',
        deadlineAt: null,
        messageSentAt: null,
        createdAt: new Date(),
        warnings: [],
        purpose: null,
        timeoutMinutes: null,
        message: null,
        messageFileIds: null,
        createdByUserId: 242,
        createdByName: 'Тест',
        error: null,
        ...over,
      }) as PaymentRequest;
    const wire = (t: ReturnType<typeof setup>, req: PaymentRequest) => {
      (t.prisma.paymentRequest as unknown as Record<string, unknown>).findFirst = vi.fn(async () => req);
      (t.prisma.paymentRequest as unknown as Record<string, unknown>).update = vi.fn(async ({ data }: { data: Partial<PaymentRequest> }) => Object.assign(req, data));
    };

    it('send: сообщение уходит, срок с этого момента, статус «ждём оплату»', async () => {
      const t = setup();
      const req = baseReq();
      wire(t, req);
      const r = await t.svc.send(t.user, 'rq1');
      expect(r).toMatchObject({ status: 'sent', messageSent: true });
      expect(r.deadline).not.toBeNull();
      expect(t.calls.some(([m]) => m === 'imopenlines.crm.message.add')).toBe(true);
    });

    it('send: ссылки ещё нет — обычное ожидание ссылки (появилась — отправка)', async () => {
      const t = setup({ link: 'https://pay.example/x' });
      const req = baseReq({ status: 'link_pending', link: null });
      wire(t, req);
      const r = await t.svc.send(t.user, 'rq1');
      expect(r).toMatchObject({ status: 'sent', messageSent: true });
    });

    it('send: уже отправлен или закрыт → 409; без payment.send в группе счёта → 403; не найден → 400', async () => {
      const a = setup();
      wire(a, baseReq({ messageSentAt: new Date() }));
      await expect(a.svc.send(a.user, 'rq1')).rejects.toMatchObject({ status: 409, response: { code: 'ALREADY_SENT' } });
      const b = setup();
      wire(b, baseReq({ status: 'expired' }));
      await expect(b.svc.send(b.user, 'rq1')).rejects.toMatchObject({ status: 409, response: { code: 'NOT_SENDABLE' } });
      const c = setup({ permissions: [] });
      wire(c, baseReq());
      await expect(c.svc.send(c.user, 'rq1')).rejects.toMatchObject({ status: 403 });
      const d = setup();
      (d.prisma.paymentRequest as unknown as Record<string, unknown>).findFirst = vi.fn(async () => null);
      await expect(d.svc.send(d.user, 'rq1')).rejects.toMatchObject({ status: 400 });
    });

    it('awaiting: только свои группы, раньше истекающие сверху, без срока — в конце', async () => {
      const t = setup();
      (t.prisma.paymentRequest as unknown as Record<string, unknown>).findMany = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        expect(where).toMatchObject({ portalId: 'p1', status: 'sent', groupId: { in: ['g1'] } });
        return [
          baseReq({ id: 'b', dealId: 700, deadlineAt: new Date('2026-11-01T10:00:00Z'), messageSentAt: new Date(), createdAt: new Date('2026-10-30T10:00:00Z') }),
          baseReq({ id: 'c', dealId: 701, kind: 'custom', purpose: 'Сертификат', deadlineAt: null, messageSentAt: new Date(), createdAt: new Date('2026-10-31T10:00:00Z') }),
          baseReq({ id: 'a', dealId: 678, deadlineAt: new Date('2026-10-31T09:00:00Z'), messageSentAt: new Date(), createdAt: new Date('2026-10-29T10:00:00Z') }),
        ];
      });
      (t.user.client as unknown as { listAll: unknown }).listAll = vi.fn(async () => [{ ID: '678', TITLE: 'Баня' }]);
      const r = await t.svc.awaiting(t.user);
      expect(r.invoices.map((i) => i.requestId)).toEqual(['a', 'b', 'c']);
      expect(r.invoices[0].dealTitle).toBe('Баня');
      expect(r.invoices[1].dealTitle).toBe('Сделка #700');
      expect(r.invoices[2]).toMatchObject({ purpose: 'Сертификат', deadline: null });
    });

    it('awaiting: без права payment.send — пустой список без чтения базы', async () => {
      const t = setup({ permissions: [] });
      const r = await t.svc.awaiting(t.user);
      expect(r.invoices).toEqual([]);
      expect(t.prisma.paymentRequest.findMany).not.toHaveBeenCalled();
    });

    it('invoice-view: данные счёта, заявки, брони и файлов; полнота по наличию заявки', async () => {
      const t = setup();
      (t.prisma.paymentRequest as unknown as Record<string, unknown>).findFirst = vi.fn(async () =>
        baseReq({ bookingId: 5918, link: null, message: 'Оплатите {link}', messageFileIds: ['f1'] as unknown as PaymentRequest['messageFileIds'] }),
      );
      (t.prisma.bookingRecord as unknown as Record<string, unknown>).findUnique = vi.fn(async () => ({
        bookingId: 5918,
        startsAt: new Date('2026-11-02T10:00:00Z'),
        endsAt: new Date('2026-11-02T14:00:00Z'),
        resourceIds: [2],
      }));
      const v = await t.svc.invoiceView(t.user, 678, 6001);
      expect(v).toMatchObject({
        complete: true,
        status: 'issued',
        state: 'open',
        messageText: 'Оплатите {link}',
        booking: { bookingId: 5918, resources: ['Баня 2'] },
        contact: { id: 140, name: 'Анна Петрова' },
        dealTitle: 'Баня на субботу',
      });
      expect(v.messageFiles).toEqual([{ id: 'f1', name: 'прайс.pdf', mime: 'application/pdf', size: 1 }]);
      // Счёт не приложения: заявки нет — данные неполные.
      const u = setup();
      (u.prisma.paymentRequest as unknown as Record<string, unknown>).findFirst = vi.fn(async () => null);
      expect(await u.svc.invoiceView(u.user, 678, 6003)).toMatchObject({ complete: false, request: null, messageText: null, booking: null });
    });
  });

  describe('окно оплаты: свой текст и вложения', () => {
    const template = { id: 'tp1', name: 'Предоплата бани', steps: [{ text: 'Оплатите {prepayment} ₽: {link} до {deadline}', fileIds: [] }, { text: 'Правила', fileIds: ['f1'] }] };

    it('preview: текст шаблона без 📎, {link} и {deadline} остаются; файлы, сделка, контакт', async () => {
      const t = setup({ template });
      const p = await t.svc.preview(t.user, 678, 'prepayment', undefined, undefined, 'tp1');
      expect(p.templateId).toBe('tp1');
      expect(p.messageText).toBe('Оплатите 45 000 ₽: {link} до {deadline}\n\nПравила');
      expect(p.messageText).not.toContain('📎');
      expect(p.message).toContain('📎 файл из шаблона');
      expect(p.messageFiles).toEqual([{ id: 'f1', name: 'прайс.pdf', mime: 'application/pdf', size: 1 }]);
      expect(p.deal).toEqual({ title: 'Баня на субботу', amount: 90000, currency: 'RUB' });
      expect(p.contact).toEqual({ id: 140, name: 'Анна Петрова' });
    });

    it('preview: шаблон группы — его id; без шаблона — стандартный текст и null', async () => {
      const t = setup({ template });
      (options.payments as Record<string, unknown>).prepaymentTemplateId = 'tp1';
      try {
        expect((await t.svc.preview(t.user, 678, 'prepayment')).templateId).toBe('tp1');
      } finally {
        delete (options.payments as Record<string, unknown>).prepaymentTemplateId;
      }
      const d = await setup().svc.preview(t.user, 678, 'prepayment');
      expect(d).toMatchObject({ templateId: null, messageFiles: [] });
      expect(d.messageText).toContain('{link}');
    });

    it('preview: шаблон другого портала или не найден → 400 TEMPLATE_NOT_FOUND; для произвольной игнорируется', async () => {
      const t = setup({ template });
      const other = { ...t.user, portal: { ...t.user.portal, id: 'p2' } } as B24UserContext;
      await expect(t.svc.preview(other, 678, 'prepayment', undefined, undefined, 'tp1')).rejects.toMatchObject({ status: 400, response: { code: 'TEMPLATE_NOT_FOUND' } });
      await expect(t.svc.preview(t.user, 678, 'surcharge', undefined, undefined, 'nope')).rejects.toMatchObject({ status: 400, response: { code: 'TEMPLATE_NOT_FOUND' } });
      const c = await t.svc.preview(t.user, 678, 'custom', undefined, undefined, 'nope');
      expect(c).toMatchObject({ templateId: null, messageText: 'Просим Вам произвести оплату {{СсылкаНаОплату}}', messageFiles: [], contact: { id: 140 } });
    });

    it('preview: нет доступа к контакту → contact null', async () => {
      const t = setup({ contactDenied: true });
      expect((await t.svc.preview(t.user, 678, 'prepayment')).contact).toBeNull();
    });

    it('create: свой текст и файлы сохраняются в заявке; файлы без текста, чужой файл → 400', async () => {
      const files = [
        { id: 'mine1', name: 'схема.png', mime: 'image/png', size: 2, ownerUserId: 242 },
        { id: 'f1', name: 'прайс.pdf', mime: 'application/pdf', size: 1, ownerUserId: 1 },
        { id: 'alien', name: 'чужой.pdf', mime: 'application/pdf', size: 1, ownerUserId: 5 },
      ];
      const t = setup({ template, files });
      await t.svc.create(t.user, body({ message: 'Оплатите: {link}', fileIds: ['mine1', 'f1'] }));
      expect(t.prisma.paymentRequest.create).toHaveBeenCalledWith({ data: expect.objectContaining({ message: 'Оплатите: {link}', messageFileIds: ['mine1', 'f1'] }) });
      await expect(t.svc.create(t.user, body({ idempotencyKey: 'pay-2', fileIds: ['mine1'] }))).rejects.toMatchObject({ status: 400 });
      await expect(t.svc.create(t.user, body({ idempotencyKey: 'pay-3xxxxxx', fileIds: ['mine1'] }))).rejects.toMatchObject({ status: 400, response: { code: 'INVALID_PAYMENT' } });
      await expect(t.svc.create(t.user, body({ idempotencyKey: 'pay-4xxxxxx', message: 'x', fileIds: ['mine1', 'mine1'] }))).rejects.toMatchObject({ status: 400 });
      await expect(t.svc.create(t.user, body({ idempotencyKey: 'pay-5xxxxxx', message: 'x', fileIds: ['alien'] }))).rejects.toMatchObject({ status: 400, response: { code: 'FILE_NOT_FOUND' } });
      await expect(t.svc.create(t.user, body({ idempotencyKey: 'pay-6xxxxxx', message: 'x', fileIds: ['gone'] }))).rejects.toMatchObject({ status: 400, response: { code: 'FILE_NOT_FOUND' } });
      expect(t.calls.filter((c) => c[0] === 'crm.item.add')).toHaveLength(1);
    });

    it.each(['prepayment', 'surcharge'] as const)('%s: свой текст — одно сообщение, ссылка не задваивается при {link}, файлы уходят', async (kind) => {
      const files = [{ id: 'mine1', name: 'схема.png', mime: 'image/png', size: 2, ownerUserId: 242 }];
      const t = setup({ link: 'https://pay.example/x', files });
      await t.svc.create(t.user, body({ kind, amount: 25000, message: 'Анна, оплатите {prepayment} ₽: {link}', fileIds: ['mine1'] }));
      const sent = t.calls.filter((c) => c[0] === 'imopenlines.crm.message.add').map((c) => c[1].MESSAGE);
      expect(sent).toEqual(['Анна, оплатите 25 000 ₽: https://pay.example/x']);
      expect(t.calls.filter((c) => c[0] === 'im.v2.File.upload').map((c) => (c[1].fields as { name: string }).name)).toEqual(['схема.png']);
    });

    it('свой текст без переменной ссылки — ссылка последней строкой; {{СсылкаНаОплату}} — на её месте', async () => {
      const t = setup({ link: 'https://pay.example/x' });
      await t.svc.create(t.user, body({ message: 'Ждём оплату' }));
      const u = setup({ link: 'https://pay.example/x' });
      await u.svc.create(u.user, body({ kind: 'custom', amount: 100, purpose: 'Сертификат' }));
      expect(t.calls.filter((c) => c[0] === 'imopenlines.crm.message.add').map((c) => c[1].MESSAGE)).toEqual(['Ждём оплату\nhttps://pay.example/x']);
      expect(u.calls.filter((c) => c[0] === 'imopenlines.crm.message.add').map((c) => c[1].MESSAGE)).toEqual(['Просим Вам произвести оплату https://pay.example/x']);
    });
  });
});
