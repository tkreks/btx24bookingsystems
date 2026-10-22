import type { PaymentRequest, Portal } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { Bitrix24RestClient } from '../bitrix24/rest/rest-client.js';
import { Bitrix24Error } from '../bitrix24/rest/errors.js';
import type { BookingJournalService } from '../bookings/booking-journal.service.js';
import type { DealFieldMapService } from '../bookings/deal-field-map.service.js';
import { PaymentFlow } from './payment-flow.js';

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

function setup(o: { link?: string; stage?: string; sendFails?: boolean; chats?: string[]; closedSession?: boolean; payments?: { id: number; paid: string }[]; ownInvoice?: boolean; booking?: boolean } = {}) {
  const calls: [string, Record<string, unknown>][] = [];
  const call = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    calls.push([method, params]);
    if (method === 'crm.item.get') return { result: { item: { id: 6001, categoryId: 2, stageId: o.stage ?? 'DT31_2:N', ufCrmLink: o.link ?? '' } } };
    if (method === 'crm.deal.get') return { result: { ID: '678', CONTACT_ID: '140', ASSIGNED_BY_ID: '236', OPPORTUNITY: '90000', UF_VD: '01.06.2020' } };
    if (method === 'crm.contact.get') return { result: { NAME: 'Анна' } };
    if (method === 'imopenlines.crm.chat.get') return { result: (o.chats ?? ['3301']).map((CHAT_ID) => ({ CHAT_ID })) };
    if (method === 'imopenlines.crm.message.add' && o.sendFails) throw new Bitrix24Error('ACCESS_DENIED', 'no');
    if (method === 'imopenlines.crm.message.add' && (params.CHAT_ID === 14034 || o.closedSession)) throw new Bitrix24Error('CHAT_NOT_IN_CRM', 'other deal');
    if (method === 'imopenlines.dialog.get') return { result: { entity_data_2: `CONTACT|140|DEAL|${params.CHAT_ID === 4396 ? 678 : 2432}` } };
    if (method === 'crm.item.payment.list') return { result: o.payments ?? [] };
    return { result: true };
  });
  const client = { call } as unknown as Bitrix24RestClient;
  let row: PaymentRequest;
  const prisma = {
    workGroup: { findUnique: vi.fn(async () => ({ options })) },
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
  const flow = new PaymentFlow(prisma, journal as unknown as BookingJournalService, fieldMap);
  const req = (over: Partial<PaymentRequest> = {}): PaymentRequest =>
    (row = {
      id: 'q1', portalId: 'p1', idempotencyKey: 'k', dealId: 678, bookingId: o.booking ? 5918 : null, groupId: 'g1', kind: 'prepayment',
      amount: 25000 as unknown as PaymentRequest['amount'], invoiceId: 6001, link: null, status: 'link_pending', deadlineAt: null, messageSentAt: null,
      paidAt: null, closedAt: null, createdByUserId: 242, createdByName: 'Тест', error: null, warnings: [], attempts: 0, createdAt: new Date(), updatedAt: new Date(),
      ...over,
    } as PaymentRequest);
  const ctx = { portal, client, actor: { kind: 'system' as const, name: 'test' } };
  return { flow, calls, ctx, req, journal, row: () => row };
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

  it('paid invoice → paid, success stage, booking history', async () => {
    const t = setup({ stage: 'DT31_2:P', booking: true });
    const r = await t.flow.watch(t.ctx, t.req({ status: 'sent', deadlineAt: new Date(Date.now() + 60_000) }));
    expect(r.status).toBe('paid');
    expect(t.calls.find((c) => c[0] === 'crm.deal.update')![1]).toEqual({ id: 678, fields: { STAGE_ID: 'EXECUTING' } });
    expect(t.journal.note).toHaveBeenCalledWith('r1', 'paid', expect.anything(), expect.objectContaining({ amount: 25000 }), 'worker');
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

  it('still waiting before the deadline — nothing changes', async () => {
    const t = setup();
    const r = await t.flow.watch(t.ctx, t.req({ status: 'sent', deadlineAt: new Date(Date.now() + 60_000) }));
    expect(r.status).toBe('sent');
    expect(t.calls.map((c) => c[0])).toEqual(['crm.item.get']);
  });
});
