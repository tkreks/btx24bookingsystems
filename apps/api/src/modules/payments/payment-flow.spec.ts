import type { PaymentRequest, Portal } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { Bitrix24RestClient } from '../bitrix24/rest/rest-client.js';
import { Bitrix24Error } from '../bitrix24/rest/errors.js';
import type { BookingJournalService } from '../bookings/booking-journal.service.js';
import type { DealFieldMapService } from '../bookings/deal-field-map.service.js';
import { PaymentFlow } from './payment-flow.js';
import { MessageContextService } from '../bookings/message-context.service.js';

const portal = { id: 'p1', timezone: 'Europe/Moscow' } as Portal;
const options = {
  payments: {
    prepayment: { stageId: 'UC_DIZN23', moveStage: true, templateId: '' },
    surcharge: { stageId: '', moveStage: false, templateId: '' },
    timeoutMinutes: 90,
    successStageId: 'EXECUTING',
    failStageId: 'NEW',
    successTemplateId: '',
    failTemplateId: '',
    clientMessage: '{client_name}, предоплата {prepayment} ₽: {link} — до {deadline} ({minutes} мин)',
    failMessage: 'Бронь на {date_start} снята',
    invoice: { categoryId: 2, prepaymentStageId: 'DT31_2:N', surchargeStageId: 'DT31_2:S', linkField: 'ufCrmLink', fields: {} },
  },
};
const map = { prepaymentLink: 'UF_LINK', visitDateStart: 'UF_VD' };

function setup(o: { link?: string; stage?: string; sendFails?: boolean; chats?: string[]; contactChats?: string[]; wrongContact?: boolean; closedSession?: boolean; payments?: { id: number; paid: string }[]; ownInvoice?: boolean; booking?: boolean } = {}) {
  const calls: [string, Record<string, unknown>][] = [];
  const call = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    calls.push([method, params]);
    if (method === 'crm.item.get') return { result: { item: { id: 6001, categoryId: 2, stageId: o.stage ?? 'DT31_2:N', ufCrmLink: o.link ?? '' } } };
    if (method === 'crm.deal.get') return { result: { ID: '678', CONTACT_ID: '140', ASSIGNED_BY_ID: '236', OPPORTUNITY: '90000', UF_VD: '01.06.2020' } };
    if (method === 'crm.contact.get') return { result: { NAME: 'Анна' } };
    if (method === 'crm.deal.fields') return { result: { UF_VD: { type: 'string', title: 'Дата начала визита' }, OPPORTUNITY: { type: 'double', title: 'Сумма' } } };
    if (method === 'crm.contact.fields') return { result: { NAME: { type: 'string', title: 'Имя' } } };
    if (method === 'crm.deal.productrows.get') return { result: [{ PRODUCT_NAME: 'Программа «Алатырь»' }] };
    if (method === 'disk.file.get') return { result: { NAME: 'Правила.pdf', DOWNLOAD_URL: 'https://portal/x' } };
    if (method === 'imopenlines.crm.chat.get') return { result: (params.CRM_ENTITY_TYPE === 'contact' ? (o.contactChats ?? []) : (o.chats ?? ['3301'])).map((CHAT_ID) => ({ CHAT_ID })) };
    if (method === 'imopenlines.crm.message.add' && params.CRM_ENTITY_TYPE === 'contact' && !o.sendFails) return { result: 42 };
    if (method === 'imopenlines.crm.message.add' && o.sendFails) throw new Bitrix24Error('ACCESS_DENIED', 'no');
    if (method === 'imopenlines.crm.message.add' && (params.CHAT_ID === 14034 || o.closedSession)) throw new Bitrix24Error('CHAT_NOT_IN_CRM', 'other deal');
    if (method === 'imopenlines.dialog.get') return { result: { entity_data_2: `CONTACT|${o.wrongContact ? 999 : 140}|DEAL|${params.CHAT_ID === 4396 ? 678 : 2432}` } };
    if (method === 'crm.item.payment.list') return { result: o.payments ?? [] };
    return { result: true };
  });
  const client = { call, download: vi.fn(async () => ({ data: Buffer.from('pdf'), contentType: null })) } as unknown as Bitrix24RestClient;
  let row: PaymentRequest;
  const prisma = {
    storedFile: { findFirst: vi.fn(async () => ({ name: 'Правила.pdf', data: Buffer.from('pdf') })) },
    workGroup: { findUnique: vi.fn(async () => ({ options })), findMany: vi.fn(async () => [{ options }]) },
    bookingRecord: { findUnique: vi.fn(async () => null) },
    paymentRequest: { update: vi.fn(async ({ data }: { data: Partial<PaymentRequest> }) => (row = { ...row, ...data } as PaymentRequest)) },
    appCreatedEntity: {
      findUnique: vi.fn(async () => (o.ownInvoice === false ? null : { id: 'x' })),
      upsert: vi.fn(async () => ({})),
    },
  } as unknown as PrismaService;
  const journal = {
    find: vi.fn(async () => (o.booking ? { id: 'r1', status: 'active' } : null)),
    note: vi.fn(async () => undefined),
    recordCancelled: vi.fn(async () => ({})),
  };
  const fieldMap = { get: vi.fn(async () => map) } as unknown as DealFieldMapService;
  const flow = new PaymentFlow(prisma, journal as unknown as BookingJournalService, fieldMap, new MessageContextService(prisma, fieldMap));
  flow.sleep = async () => {};
  const req = (over: Partial<PaymentRequest> = {}): PaymentRequest =>
    (row = {
      id: 'q1', portalId: 'p1', idempotencyKey: 'k', dealId: 678, bookingId: o.booking ? 5918 : null, groupId: 'g1', kind: 'prepayment',
      amount: 25000 as unknown as PaymentRequest['amount'], invoiceId: 6001, link: null, status: 'link_pending', deadlineAt: null, messageSentAt: null,
      paidAt: null, closedAt: null, createdByUserId: 242, createdByName: 'Тест', error: null, warnings: [], attempts: 0, createdAt: new Date(), updatedAt: new Date(),
      ...over,
    } as PaymentRequest);
  const ctx = { portal, client, actor: { kind: 'system' as const, name: 'test' } };
  return { flow, calls, ctx, req, journal, prisma, row: () => row };
}

describe('PaymentFlow', () => {
  it('waits for the portal to put the link into the invoice', async () => {
    const t = setup({ link: '' });
    const r = await t.flow.awaitLink(t.ctx, t.req());
    expect(r.status).toBe('link_pending');
    expect(t.calls.map((c) => c[0])).toEqual(['crm.item.get']);
  });

  it('link → deal field, message to the client chat, comment; deadline starts when sent', async () => {
    const t = setup({ link: 'https://pay.example/x' });
    const before = Date.now();
    const r = await t.flow.awaitLink(t.ctx, t.req());
    expect(r).toMatchObject({ status: 'sent', link: 'https://pay.example/x' });
    expect(r.deadlineAt!.getTime()).toBeGreaterThanOrEqual(before + 90 * 60_000);
    expect(t.calls.find((c) => c[0] === 'crm.deal.update')![1]).toEqual({ id: 678, fields: { UF_LINK: 'https://pay.example/x' } });
    const m = t.calls.find((c) => c[0] === 'imopenlines.crm.message.add')![1];
    expect(m).toMatchObject({ CRM_ENTITY_TYPE: 'deal', CRM_ENTITY: 678, USER_ID: 242, CHAT_ID: 3301 });
    expect(m.MESSAGE).toMatch(/^Анна, предоплата 25\s000 ₽: https:\/\/pay\.example\/x — до \d\d:\d\d \d\d\.\d\d\.\d{4} \(90 мин\)$/);
    expect(t.calls.some((c) => c[0] === 'crm.timeline.comment.add')).toBe(true);
  });

  it('skips a chat that moved to another deal of the client', async () => {
    const t = setup({ link: 'https://pay.example/x', chats: ['4396', '14034'] });
    const r = await t.flow.awaitLink(t.ctx, t.req());
    expect(r.messageSentAt).not.toBeNull();
    expect(t.calls.filter((c) => c[0] === 'imopenlines.crm.message.add').map((c) => c[1].CHAT_ID)).toEqual([14034, 4396]);
  });

  it('closed session → operator message into the chat bound to this deal', async () => {
    const t = setup({ link: 'https://pay.example/x', chats: ['4396', '14034'], closedSession: true });
    const r = await t.flow.awaitLink(t.ctx, t.req());
    expect(r.messageSentAt).not.toBeNull();
    expect(t.calls.filter((c) => c[0] === 'im.message.add').map((c) => c[1].DIALOG_ID)).toEqual(['chat4396']);
  });

  it('message not delivered → no deadline (booking is not cancelled), warning to send manually', async () => {
    const t = setup({ link: 'https://pay.example/x', sendFails: true });
    const r = await t.flow.awaitLink(t.ctx, t.req());
    expect(r.status).toBe('sent');
    expect(r.deadlineAt).toBeNull();
    expect(t.calls.filter((c) => c[0] === 'imopenlines.crm.message.add').map((c) => c[1].USER_ID)).toEqual([242, 236]);
    expect(r.warnings).toEqual([expect.stringContaining('отправьте ссылку вручную')]);
  });

  it('новая сделка без чата → сообщение через проверенный чат контакта (другая сделка чата допустима)', async () => {
    const t = setup({ link: 'https://pay.example/x', chats: [], contactChats: ['14034'] });
    const result = await t.flow.awaitLink(t.ctx, t.req());
    expect(result.messageSentAt).not.toBeNull();
    expect(result.deadlineAt).not.toBeNull();
    expect(t.ctx.client.call).toHaveBeenCalledWith('imopenlines.crm.message.add', expect.objectContaining({ CRM_ENTITY_TYPE: 'contact', CRM_ENTITY: 140, CHAT_ID: 14034 }));
  });

  it('не отправляет ссылку в чат постороннего контакта даже если поиск его вернул', async () => {
    const t = setup({ link: 'https://pay.example/x', chats: [], contactChats: ['14034'], wrongContact: true });
    const result = await t.flow.awaitLink(t.ctx, t.req());
    expect(result.messageSentAt).toBeNull();
    expect(result.deadlineAt).toBeNull();
    expect(t.calls.some(([m]) => m === 'imopenlines.crm.message.add' || m === 'im.message.add')).toBe(false);
  });

  it('paid invoice → paid, success stage, booking history', async () => {
    const t = setup({ stage: 'DT31_2:P', booking: true });
    const r = await t.flow.watch(t.ctx, t.req({ status: 'sent', deadlineAt: new Date(Date.now() + 60_000) }));
    expect(r.status).toBe('paid');
    expect(t.calls.find((c) => c[0] === 'crm.deal.update')![1]).toEqual({ id: 678, fields: { STAGE_ID: 'EXECUTING' } });
    expect(t.journal.note).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }), 'paid', expect.anything(), expect.objectContaining({ amount: 25000 }), 'worker');
  });

  it('deadline passed → invoice «not paid», unpaid payments deleted, booking removed, fail stage and message', async () => {
    const t = setup({ booking: true, payments: [{ id: 9001, paid: 'N' }, { id: 9002, paid: 'Y' }] });
    const r = await t.flow.watch(t.ctx, t.req({ status: 'sent', deadlineAt: new Date(Date.now() - 1000) }));
    expect(r.status).toBe('expired');
    const m = t.calls.map((c) => c[0]);
    expect(t.calls.find((c) => c[0] === 'crm.item.update')![1]).toEqual({ entityTypeId: 31, id: 6001, fields: { stageId: 'DT31_2:D' } });
    expect(t.calls.filter((c) => c[0] === 'crm.item.payment.delete').map((c) => c[1].id)).toEqual([9001]);
    expect(t.calls.find((c) => c[0] === 'booking.v1.booking.delete')![1]).toEqual({ id: 5918 });
    expect(t.journal.recordCancelled).toHaveBeenCalledWith('p1', 5918, expect.objectContaining({ reason: 'payment_timeout', via: 'worker' }));
    expect(t.calls.find((c) => c[0] === 'crm.deal.update')![1]).toEqual({ id: 678, fields: { STAGE_ID: 'NEW' } });
    expect(t.calls.find((c) => c[0] === 'imopenlines.crm.message.add')![1].MESSAGE).toBe('Бронь на 01.06.2020 снята');
    expect(m.indexOf('crm.item.payment.delete')).toBeLessThan(m.indexOf('booking.v1.booking.delete'));
  });

  it('invoice set to «not paid» by hand → waiting stops at once, link annulled, booking and client untouched', async () => {
    const t = setup({ stage: 'DT31_2:D', booking: true, payments: [{ id: 9001, paid: 'N' }] });
    const r = await t.flow.watch(t.ctx, t.req({ status: 'sent', deadlineAt: new Date(Date.now() + 60 * 60_000) }));
    expect(r.status).toBe('cancelled');
    expect(r.error).toContain('«Не оплачен»');
    expect(t.calls.filter((c) => c[0] === 'crm.item.payment.delete').map((c) => c[1].id)).toEqual([9001]);
    expect(t.calls.map((c) => c[0])).not.toContain('booking.v1.booking.delete');
    expect(t.calls.map((c) => c[0])).not.toContain('imopenlines.crm.message.add');
    expect(t.journal.note).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }), 'payment_cancelled', expect.anything(), { invoiceId: 6001 }, 'worker');
  });

  it('paid → confirmation of the booking type with variables, then its Disk file in the deal chat', async () => {
    const o = options as unknown as { bookingTypes?: unknown; payments: { sendConfirmation?: boolean } };
    o.bookingTypes = [{ id: 'p', title: 'Программы', keywords: ['Алатырь'], dealTypeValue: '86', program: '@keyword', confirmation: [{ text: '{{Контакт: Имя}}, ждём вас! Программа: {=Variable:programm > printable}, сумма {{Сумма}}', files: [{ id: 92152, name: 'Правила.pdf' }] }] }];
    o.payments.sendConfirmation = true;
    try {
      const t = setup({ stage: 'DT31_2:P', chats: ['4396'] });
      const r = await t.flow.watch(t.ctx, t.req({ status: 'sent', deadlineAt: new Date(Date.now() + 60_000) }));
      expect(r.status).toBe('paid');
      expect(t.calls.find((c) => c[0] === 'imopenlines.crm.message.add')![1].MESSAGE).toBe('Анна, ждём вас! Программа: Алатырь, сумма 90 000');
      expect(t.calls.find((c) => c[0] === 'im.v2.File.upload')![1]).toEqual({ dialogId: 'chat4396', fields: { name: 'Правила.pdf', content: Buffer.from('pdf').toString('base64') } });
      const names = t.calls.map((c) => c[0]);
      expect(names.indexOf('imopenlines.crm.message.add')).toBeLessThan(names.indexOf('im.v2.File.upload'));
    } finally {
      delete o.bookingTypes;
      o.payments.sendConfirmation = false;
    }
  });

  it('still waiting before the deadline — nothing changes', async () => {
    const t = setup();
    const r = await t.flow.watch(t.ctx, t.req({ status: 'sent', deadlineAt: new Date(Date.now() + 60_000) }));
    expect(r.status).toBe('sent');
    expect(t.calls.map((c) => c[0])).toEqual(['crm.item.get']);
  });
});


describe('Вложения системных цепочек', () => {
  it('локальная копия подтверждения читается только в портале отправки и идёт после текста', async () => {
    const t = setup({ chats: ['4396'] });
    const warnings: string[] = [];
    const result = await t.flow.sendChain(t.ctx, { dealId: 678, userId: 242, source: 'payment' }, null, [{ text: 'Ссылка на оплату', files: [{ storedFileId: 'f1', name: 'Правила.pdf' }] }, { text: 'Следующее сообщение', files: [] }], warnings);
    expect(result).toBe(true);
    expect(t.calls.filter(([m]) => ['imopenlines.crm.message.add', 'im.v2.File.upload'].includes(m)).map(([m,p]) => m === 'im.v2.File.upload' ? 'file' : p.MESSAGE)).toEqual(['Ссылка на оплату', 'file', 'Следующее сообщение']);
    expect(t.prisma.storedFile.findFirst).toHaveBeenCalledWith({ where: { portalId: 'p1', id: 'f1' }, select: { name: true, data: true } });
    expect(t.calls.find(([m]) => m === 'im.v2.File.upload')?.[1]).toMatchObject({ dialogId: 'chat4396', fields: { name: 'Правила.pdf', content: Buffer.from('pdf').toString('base64') } });
  });
});
