import { DealPaymentsService } from './deal-payments.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { DealFieldMapService } from './deal-field-map.service.js';
import type { Bitrix24RestClient } from '../bitrix24/rest/rest-client.js';
import type { Portal } from '../../generated/prisma/client.js';

const F = 'UF_PAID';
const portal = { id: 'p1', timezone: 'Europe/Moscow' } as Portal;
const now = new Date('2026-10-23T15:00:00Z'); // 18:00 МСК

function setup(rows: Record<string, string | null>[]) {
  const amounts = new Map<number, { dealId: number; amount: number; checkedAt: Date }>();
  const payments: { dealId: number; amount: number; total: number; at: Date }[] = [];
  const prisma = {
    dealPaidAmount: {
      findUnique: vi.fn(async ({ where }: { where: { portalId_dealId: { dealId: number } } }) => amounts.get(where.portalId_dealId.dealId) ?? null),
      findMany: vi.fn(async ({ where }: { where: { dealId: { in: number[] } } }) => where.dealId.in.flatMap((id) => (amounts.has(id) ? [amounts.get(id)!] : []))),
      createMany: vi.fn(async ({ data }: { data: { dealId: number; amount: number; checkedAt: Date }[] }) => data.forEach((d) => amounts.set(d.dealId, d))),
      upsert: vi.fn(async ({ where, create, update }: { where: { portalId_dealId: { dealId: number } }; create: { dealId: number; amount: number; checkedAt: Date }; update: Partial<{ amount: number; checkedAt: Date }> }) => {
        const id = where.portalId_dealId.dealId;
        amounts.set(id, amounts.has(id) ? { ...amounts.get(id)!, ...update } : create);
      }),
    },
    dealPayment: {
      createMany: vi.fn(async ({ data }: { data: typeof payments }) => payments.push(...data)),
      create: vi.fn(async ({ data }: { data: (typeof payments)[number] }) => payments.push(data)),
    },
  } as unknown as PrismaService;
  const fieldMap = { outcome: vi.fn(async () => ({ paidAmount: F, certificateTypeId: null })) } as unknown as DealFieldMapService;
  const client = { listAll: vi.fn(async () => rows) } as unknown as Bitrix24RestClient;
  return { svc: new DealPaymentsService(prisma, fieldMap), client, amounts, payments, setRows: (r: typeof rows) => (rows.splice(0, rows.length, ...r), undefined) };
}

describe('DealPaymentsService', () => {
  it('первый проход запоминает оплаченные; созданные сегодня и уже оплаченные — оплата сегодня; дальше — рост суммы', async () => {
    const rows = [
      { ID: '1', DATE_CREATE: '2026-10-01T10:00:00+03:00', DATE_MODIFY: '2026-10-23T09:00:00+03:00', [F]: '25000|RUB' },
      { ID: '2', DATE_CREATE: '2026-10-23T09:00:00+03:00', DATE_MODIFY: '2026-10-23T12:30:00+03:00', [F]: '25000|RUB' },
    ];
    const t = setup(rows);
    expect(await t.svc.scan(portal, t.client, now)).toEqual({ payments: 1 });
    expect(t.payments).toMatchObject([{ dealId: 2, amount: 25000, at: new Date('2026-10-23T09:30:00Z') }]);
    // Следующий проход: доплата по 1, новая оплата по 3, по 2 без изменений.
    t.setRows([
      { ID: '1', DATE_CREATE: '2026-10-01T10:00:00+03:00', DATE_MODIFY: '2026-10-23T18:02:00+03:00', [F]: '40000|RUB' },
      { ID: '2', DATE_CREATE: '2026-10-23T09:00:00+03:00', DATE_MODIFY: '2026-10-23T18:01:00+03:00', [F]: '25000|RUB' },
      { ID: '3', DATE_CREATE: '2026-10-20T09:00:00+03:00', DATE_MODIFY: '2026-10-23T18:03:00+03:00', [F]: '10000|RUB' },
      { ID: '4', DATE_CREATE: '2026-10-20T09:00:00+03:00', DATE_MODIFY: '2026-10-23T18:03:00+03:00', [F]: null },
    ]);
    expect(await t.svc.scan(portal, t.client, new Date('2026-10-23T15:05:00Z'))).toEqual({ payments: 2 });
    expect(t.payments.slice(1)).toMatchObject([
      { dealId: 1, amount: 15000, total: 40000 },
      { dealId: 3, amount: 10000, total: 10000 },
    ]);
  });

  it('оплаты периода — по счетам «Оплачен» (время перевода); учёт поля — только у сделок без оплаченных счетов', async () => {
    const start = new Date('2026-10-22T21:00:00Z');
    const end = new Date('2026-10-23T21:00:00Z');
    const prisma = {
      dealPayment: {
        findMany: vi.fn(async () => [
          // 10 — оплачена счётом вчера, поле изменилось сегодня: не оплата сегодня.
          { dealId: 10, amount: 25000, at: new Date('2026-10-23T09:00:00Z') },
          // 11 — внесли вручную, счетов нет.
          { dealId: 11, amount: 5000, at: new Date('2026-10-23T08:00:00Z') },
          // 12 — счёт оплачен сегодня: время — из счёта.
          { dealId: 12, amount: 25000, at: new Date('2026-10-23T16:42:00Z') },
        ]),
      },
    } as unknown as PrismaService;
    const call = vi.fn(async (_m: string, p: { filter: Record<string, unknown> }) =>
      p.filter['@parentId2']
        ? [{ id: 2, parentId2: 10, stageId: 'DT31_2:P' }]
        : [
            { id: 1, parentId2: 12, opportunity: 25000, stageId: 'DT31_2:P', movedTime: '2026-10-23T10:10:03+03:00' },
            { id: 3, parentId2: 13, opportunity: 9000, stageId: 'DT31_2:N', movedTime: '2026-10-23T11:00:00+03:00' },
          ],
    );
    const client = { listAll: call } as unknown as Bitrix24RestClient;
    const svc = new DealPaymentsService(prisma, {} as DealFieldMapService);
    const paid = await svc.paidIn('p1', client, start, end);
    expect([...paid.entries()]).toEqual([
      [12, { at: new Date('2026-10-23T07:10:03Z'), amount: 25000 }],
      [11, { at: new Date('2026-10-23T08:00:00Z'), amount: 5000 }],
    ]);
  });
});
