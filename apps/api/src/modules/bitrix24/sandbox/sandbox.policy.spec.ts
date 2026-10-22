import { SandboxWritePolicy } from './sandbox.policy.js';
import type { PrismaService } from '../../../prisma/prisma.service.js';
import type { Portal } from '../../../generated/prisma/client.js';
import { Bitrix24RestClient } from '../rest/rest-client.js';
import { RateLimiter } from '../rest/rate-limiter.js';

const portal = { id: 'p1', timezone: 'Europe/Moscow' } as Portal;
const cfg = { dealIds: [678], bookingsFrom: '2020-01-01', bookingsTo: '2021-01-01' };
// 2020-06-01 10:00 и 12:00 МСК
const in2020 = { from: { timestamp: 1590994800, timezone: 'Europe/Moscow' }, to: { timestamp: 1591002000, timezone: 'Europe/Moscow' } };
const in2026 = { from: { timestamp: 1780300800 }, to: { timestamp: 1780308000 } };

function setup(owned: number[] = [], alertChatId: number | null = null, grant = { createInBitrix: false }) {
  const rows = new Map(owned.map((id) => [id, { bookingId: id, deletedAt: null as Date | null }]));
  const created = new Set<string>();
  const prisma = {
    portalSettings: { findUnique: vi.fn(async () => ({ alertChatId, createInBitrix: grant.createInBitrix })) },
    appCreatedEntity: {
      findUnique: vi.fn(async ({ where }: { where: { portalId_entityType_entityId: { entityType: string; entityId: number } } }) => {
        const k = where.portalId_entityType_entityId;
        return created.has(`${k.entityType}:${k.entityId}`) ? { id: 'c' } : null;
      }),
      create: vi.fn(async ({ data }: { data: { entityType: string; entityId: number } }) => created.add(`${data.entityType}:${data.entityId}`)),
    },
    bookingAlert: {
      findFirst: vi.fn(async ({ where }: { where: { messageId: number } }) => (where.messageId === 9001 ? { id: 'a1' } : null)),
    },
    sandboxBooking: {
      findUnique: vi.fn(async ({ where }: { where: { portalId_bookingId: { bookingId: number } } }) => rows.get(where.portalId_bookingId.bookingId) ?? null),
      create: vi.fn(async ({ data }: { data: { bookingId: number } }) => rows.set(data.bookingId, { bookingId: data.bookingId, deletedAt: null })),
      updateMany: vi.fn(async ({ where }: { where: { bookingId: number } }) => {
        const r = rows.get(where.bookingId);
        if (r) r.deletedAt = new Date();
      }),
    },
  } as unknown as PrismaService;
  const relations = { contactIds: [140], invoiceIds: [5152], paymentIds: [8672, 8674], chatIds: [3301] };
  return { policy: new SandboxWritePolicy(prisma, portal, cfg, async (deals) => (deals.includes(678) ? relations : { contactIds: [], invoiceIds: [], paymentIds: [], chatIds: [] })), rows, created, grant };
}

describe('SandboxWritePolicy', () => {
  it('allows actions on the sandbox deal only', async () => {
    const { policy } = setup();
    await expect(policy.allows('crm.deal.update', { id: 678, fields: {} })).resolves.toBe(true);
    await expect(policy.allows('crm.deal.update', { id: 36440, fields: {} })).resolves.toBe(false);
    await expect(policy.allows('crm.deal.productrows.set', { id: '678', rows: [] })).resolves.toBe(true);
    await expect(policy.allows('crm.item.update', { entityTypeId: 2, id: 678 })).resolves.toBe(true);
    await expect(policy.allows('crm.item.update', { entityTypeId: 3, id: 678 })).resolves.toBe(false);
    await expect(policy.allows('bizproc.workflow.start', { TEMPLATE_ID: 1, DOCUMENT_ID: ['crm', 'CCrmDocumentDeal', 'DEAL_678'] })).resolves.toBe(true);
    await expect(policy.allows('bizproc.workflow.start', { TEMPLATE_ID: 1, DOCUMENT_ID: ['crm', 'CCrmDocumentDeal', 'DEAL_6780'] })).resolves.toBe(false);
    await expect(policy.allows('imopenlines.crm.message.add', { CRM_ENTITY_TYPE: 'deal', CRM_ENTITY: 678, MESSAGE: 'x' })).resolves.toBe(true);
    await expect(policy.allows('crm.deal.delete', { id: 678 })).resolves.toBe(false);
    await expect(policy.allows('crm.item.delete', { entityTypeId: 2, id: 678 })).resolves.toBe(false);
  });

  it('allows joining and writing only in open-lines chats of the sandbox deal', async () => {
    const { policy } = setup();
    await expect(policy.allows('imopenlines.session.join', { CHAT_ID: 3301 })).resolves.toBe(true);
    await expect(policy.allows('imopenlines.session.join', { CHAT_ID: 3302 })).resolves.toBe(false);
    await expect(policy.allows('im.message.add', { DIALOG_ID: 'chat3301', MESSAGE: 'x' })).resolves.toBe(true);
    await expect(policy.allows('im.message.add', { DIALOG_ID: 'chat3302', MESSAGE: 'x' })).resolves.toBe(false);
    await expect(policy.allows('im.message.add', { DIALOG_ID: '3301', MESSAGE: 'x' })).resolves.toBe(false);
    await expect(policy.allows('im.v2.File.upload', { dialogId: 'chat3301', fields: {} })).resolves.toBe(true);
    await expect(policy.allows('im.v2.File.upload', { dialogId: 'chat1', fields: {} })).resolves.toBe(false);
    await expect(policy.allows('im.message.delete', { MESSAGE_ID: 1 })).resolves.toBe(false);
  });

  it('allows creating the alert chat once and writing only there', async () => {
    const fresh = setup();
    await expect(fresh.policy.allows('im.chat.add', { TITLE: 'Брони' })).resolves.toBe(true);
    await expect(fresh.policy.allows('im.message.add', { DIALOG_ID: 'chat777', MESSAGE: 'x' })).resolves.toBe(false);
    const { policy } = setup([], 777);
    await expect(policy.allows('im.chat.add', { TITLE: 'Ещё один' })).resolves.toBe(false);
    await expect(policy.allows('im.message.add', { DIALOG_ID: 'chat777', MESSAGE: 'x' })).resolves.toBe(true);
    await expect(policy.allows('im.message.add', { DIALOG_ID: 'chat778', MESSAGE: 'x' })).resolves.toBe(false);
    await expect(policy.allows('im.message.update', { MESSAGE_ID: 9001, MESSAGE: 'x' })).resolves.toBe(true);
    await expect(policy.allows('im.message.update', { MESSAGE_ID: 9002, MESSAGE: 'x' })).resolves.toBe(false);
  });

  it('allows only own workday actions (no USER_ID)', async () => {
    const { policy } = setup();
    await expect(policy.allows('timeman.open', {})).resolves.toBe(true);
    await expect(policy.allows('timeman.close', { TIME: 'x', REPORT: 'y' })).resolves.toBe(true);
    await expect(policy.allows('timeman.pause', { USER_ID: 9 })).resolves.toBe(false);
  });

  it('allows editing only the contact of the sandbox deal, never deleting it', async () => {
    const { policy } = setup();
    await expect(policy.allows('crm.contact.update', { id: 140, fields: { EMAIL: [] } })).resolves.toBe(true);
    await expect(policy.allows('crm.item.update', { entityTypeId: 3, id: 140 })).resolves.toBe(true);
    await expect(policy.allows('crm.contact.update', { id: 141 })).resolves.toBe(false);
    await expect(policy.allows('crm.contact.delete', { id: 140 })).resolves.toBe(false);
  });

  it('allows annulling payments and editing invoices of the sandbox deal only', async () => {
    const { policy } = setup();
    await expect(policy.allows('crm.item.payment.delete', { id: 8674 })).resolves.toBe(true);
    await expect(policy.allows('crm.item.payment.delete', { id: 9999 })).resolves.toBe(false);
    await expect(policy.allows('crm.item.update', { entityTypeId: 31, id: 5152, fields: { stageId: 'DT31_2:D' } })).resolves.toBe(true);
    await expect(policy.allows('crm.item.update', { entityTypeId: 31, id: 5153 })).resolves.toBe(false);
    await expect(policy.allows('crm.item.delete', { entityTypeId: 31, id: 5152 })).resolves.toBe(false);
  });

  it('allows creating bookings only inside the period', async () => {
    const { policy } = setup();
    await expect(policy.allows('booking.v1.booking.add', { fields: { resourceIds: [1], datePeriod: in2020 } })).resolves.toBe(true);
    await expect(policy.allows('booking.v1.booking.add', { fields: { resourceIds: [1], datePeriod: in2026 } })).resolves.toBe(false);
    await expect(policy.allows('booking.v1.booking.add', { fields: { resourceIds: [1] } })).resolves.toBe(false);
  });

  it('touches only bookings it created itself', async () => {
    const { policy } = setup([555]);
    await expect(policy.allows('booking.v1.booking.update', { id: 555, fields: { name: 'x' } })).resolves.toBe(true);
    await expect(policy.allows('booking.v1.booking.update', { id: 555, fields: { datePeriod: in2026 } })).resolves.toBe(false);
    await expect(policy.allows('booking.v1.booking.delete', { id: 999 })).resolves.toBe(false);
    await expect(policy.allows('booking.v1.booking.externalData.set', { bookingId: 555, externalData: [{ moduleId: 'crm', entityTypeId: 'DEAL', value: '678' }] })).resolves.toBe(true);
    await expect(policy.allows('booking.v1.booking.externalData.set', { bookingId: 555, externalData: [{ moduleId: 'crm', entityTypeId: 'DEAL', value: '1' }] })).resolves.toBe(false);
  });

  it('records created bookings and forgets deleted ones', async () => {
    const { policy } = setup();
    await policy.recorded('booking.v1.booking.add', { fields: { datePeriod: in2020 } }, 777);
    await expect(policy.allows('booking.v1.booking.delete', { id: 777 })).resolves.toBe(true);
    await policy.recorded('booking.v1.booking.delete', { id: 777 }, true);
    await expect(policy.allows('booking.v1.booking.delete', { id: 777 })).resolves.toBe(false);
  });
});

describe('SandboxWritePolicy: разрешение «создавать новые»', () => {
  it('blocks creating real bookings and deals until the portal grants it', async () => {
    const { policy } = setup();
    await expect(policy.allows('booking.v1.booking.add', { fields: { datePeriod: in2026 } })).resolves.toBe(false);
    await expect(policy.allows('crm.deal.add', { fields: { TITLE: 'x' } })).resolves.toBe(false);
  });

  it('creates bookings and deals, then changes only what it created', async () => {
    const { policy, rows, created } = setup([], null, { createInBitrix: true });
    await expect(policy.allows('booking.v1.booking.add', { fields: { datePeriod: in2026 } })).resolves.toBe(true);
    await policy.recorded('booking.v1.booking.add', { fields: { datePeriod: in2026 } }, { id: 901 });
    expect(rows.has(901)).toBe(false); // не в журнал песочницы: уборка не удалит настоящую бронь
    expect(created.has('booking:901')).toBe(true);
    await expect(policy.allows('crm.deal.add', { fields: { TITLE: 'x' } })).resolves.toBe(true);
    await policy.recorded('crm.deal.add', {}, 4321);

    await expect(policy.allows('booking.v1.booking.externalData.set', { bookingId: 901, externalData: [{ moduleId: 'crm', entityTypeId: 'DEAL', value: '1' }] })).resolves.toBe(true);
    await expect(policy.allows('booking.v1.booking.client.set', { bookingId: 901 })).resolves.toBe(true);
    await expect(policy.allows('booking.v1.booking.delete', { id: 901 })).resolves.toBe(true);
    await expect(policy.allows('crm.deal.update', { id: 4321, fields: {} })).resolves.toBe(true);
    await expect(policy.allows('crm.deal.productrows.set', { id: 4321, rows: [] })).resolves.toBe(true);

    // Чужие брони и существующие сделки — только чтение.
    await expect(policy.allows('booking.v1.booking.delete', { id: 900 })).resolves.toBe(false);
    await expect(policy.allows('booking.v1.booking.externalData.set', { bookingId: 900, externalData: [{ moduleId: 'crm', entityTypeId: 'DEAL', value: '1' }] })).resolves.toBe(false);
    await expect(policy.allows('crm.deal.update', { id: 1, fields: {} })).resolves.toBe(false);
    await expect(policy.allows('crm.deal.delete', { id: 4321 })).resolves.toBe(false);
  });

  it('stops changing created entities once the grant is revoked', async () => {
    const { policy, grant } = setup([], null, { createInBitrix: true });
    await policy.recorded('booking.v1.booking.add', { fields: { datePeriod: in2026 } }, 902);
    grant.createInBitrix = false;
    await expect(policy.allows('booking.v1.booking.delete', { id: 902 })).resolves.toBe(false);
  });
});

describe('Bitrix24RestClient with a sandbox policy', () => {
  function client(owned: number[] = []) {
    const { policy, rows } = setup(owned);
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify({ result: url.includes('booking.add') ? 901 : true })));
    const c = new Bitrix24RestClient({ clientEndpoint: 'https://p/rest/', access: { getAccessToken: async () => 't', refresh: async () => 't' }, limiter: new RateLimiter(1000, 1000), limiterKey: 'm', fetch: fetchMock as unknown as typeof fetch, readOnly: true, writePolicy: policy });
    return { c, fetchMock, rows };
  }

  it('lets an allowed write through and journals the new booking', async () => {
    const { c, rows } = client();
    await c.call('booking.v1.booking.add', { fields: { resourceIds: [1], datePeriod: in2020 } });
    expect(rows.has(901)).toBe(true);
  });

  it('still blocks everything outside the sandbox, and any write inside batch', async () => {
    const { c, fetchMock } = client();
    await expect(c.call('crm.deal.update', { id: 1 })).rejects.toMatchObject({ code: 'READ_ONLY_MODE' });
    await expect(c.batch({ a: { method: 'crm.deal.update', params: { id: 678 } } })).rejects.toMatchObject({ code: 'READ_ONLY_MODE' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
