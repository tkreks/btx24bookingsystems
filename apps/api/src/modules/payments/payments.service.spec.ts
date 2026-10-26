import type { PaymentRequest } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { AccessService } from '../access/access.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import type { DealFieldMapService } from '../bookings/deal-field-map.service.js';
import { PaymentFlow } from './payment-flow.js';
import { MessageContextService } from '../bookings/message-context.service.js';
import { PaymentsService } from './payments.service.js';
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
  } = {},
) {
  const calls: [string, Record<string, unknown>][] = [];
  const call = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    calls.push([method, params]);
    if (method === 'crm.deal.get')
      return { result: { ID: '678', CATEGORY_ID: o.category ?? '0', CONTACT_ID: '140', ASSIGNED_BY_ID: '236', OPPORTUNITY: '90000', UF_PRE: '', STAGE_SEMANTIC_ID: 'P', UF_TYPE: o.dealType ?? '72' } };
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
    messageTemplate: { findFirst: vi.fn(async ({ where }: { where: { id: string } }) => (o.template?.id === where.id ? o.template : null)) },
    storedFile: { findMany: vi.fn(async () => [{ id: 'f1', name: 'прайс.pdf', data: Buffer.from('x') }]) },
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
});
