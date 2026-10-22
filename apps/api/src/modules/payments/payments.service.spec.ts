import type { PaymentRequest } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { AccessService } from '../access/access.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import type { DealFieldMapService } from '../bookings/deal-field-map.service.js';
import { PaymentFlow } from './payment-flow.js';
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

function setup(o: { permissions?: string[]; active?: boolean; prev?: Partial<PaymentRequest>; link?: string } = {}) {
  const calls: [string, Record<string, unknown>][] = [];
  const call = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    calls.push([method, params]);
    if (method === 'crm.deal.get') return { result: { ID: '678', CATEGORY_ID: '0', CONTACT_ID: '140', ASSIGNED_BY_ID: '236', OPPORTUNITY: '90000', UF_PRE: '' } };
    if (method === 'crm.item.add') return { result: { item: { id: 6001 } } };
    if (method === 'crm.item.get') return { result: { item: { id: 6001, ufCrmLink: o.link ?? '' } } };
    if (method === 'imopenlines.crm.chat.get') return { result: [{ CHAT_ID: '3301' }] };
    return { result: {} };
  });
  let row: PaymentRequest | null = null;
  const prisma = {
    paymentRequest: {
      findUnique: vi.fn(async () => (o.prev ? ({ id: 'old', amount: 1, warnings: [], createdAt: new Date(), status: 'sent', ...o.prev } as PaymentRequest) : null)),
      findFirst: vi.fn(async () => (o.active ? { id: 'a' } : null)),
      create: vi.fn(async ({ data }: { data: Partial<PaymentRequest> }) => (row = { id: 'q1', status: 'link_pending', createdAt: new Date(), invoiceId: null, link: null, deadlineAt: null, messageSentAt: null, error: null, ...data } as PaymentRequest)),
      update: vi.fn(async ({ data }: { data: Partial<PaymentRequest> }) => (row = { ...row!, ...data } as PaymentRequest)),
    },
    workGroup: { findUnique: vi.fn(async () => ({ options })) },
    bookingRecord: { findUnique: vi.fn(async () => null) },
    appCreatedEntity: { findUnique: vi.fn(async () => ({})), upsert: vi.fn() },
  } as unknown as PrismaService;
  const group = { group: { id: 'g1', name: 'Бани', dealCategoryId: 0, options }, permissions: o.permissions ?? ['payment.send'] };
  const access = { resolve: vi.fn(async () => ({ groups: [group] })) } as unknown as AccessService;
  const fieldMap = { get: vi.fn(async () => ({ prepayment: 'UF_PRE', prepaymentInvoiceId: 'UF_INV', prepaymentLink: 'UF_LINK' })) } as unknown as DealFieldMapService;
  const flow = new PaymentFlow(prisma, { find: vi.fn() } as unknown as BookingJournalService, fieldMap);
  const svc = new PaymentsService(prisma, access, fieldMap, flow);
  svc.sleep = async () => {};
  const user = { portal: { id: 'p1', timezone: 'Europe/Moscow' }, userId: 242, userName: 'Тест', client: { call } } as unknown as B24UserContext;
  return { svc, user, calls };
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
});
