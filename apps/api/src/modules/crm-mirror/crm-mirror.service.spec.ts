import type { Portal } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { Bitrix24RestClient } from '../bitrix24/rest/rest-client.js';
import type { DealFieldMapService } from '../bookings/deal-field-map.service.js';
import { CrmMirrorService } from './crm-mirror.service.js';

function setup(total: number) {
  let state: Record<string, unknown> = { backfillCursor: 0, backfillDoneAt: null, fieldsKey: null, since: null };
  const saved: number[] = [];
  const prisma = {
    crmSyncState: {
      upsert: vi.fn(async () => state),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => (state = { ...state, ...data })),
    },
    crmDeal: { upsert: vi.fn((q: { where: { portalId_dealId: { dealId: number } } }) => (saved.push(q.where.portalId_dealId.dealId), q)) },
    crmEntity: { findMany: vi.fn(async () => []), upsert: vi.fn((q: unknown) => q) },
    $transaction: vi.fn(async (ops: unknown[]) => ops),
  } as unknown as PrismaService;
  const fieldMap = { resolved: vi.fn(async () => ({ bookingEnd: 'UF_CRM_END' })), outcome: vi.fn(async () => ({ certificateTypeId: null })) } as unknown as DealFieldMapService;
  const call = vi.fn(async (_m: string, p: { filter: { '>ID': number } }) => ({
    result: Array.from({ length: Math.max(0, Math.min(50, total - p.filter['>ID'])) }, (_, i) => ({ ID: String(p.filter['>ID'] + i + 1), CONTACT_ID: '0' })),
  }));
  const client = { call, batch: vi.fn(async () => ({ result: {} })) } as unknown as Bitrix24RestClient;
  return { svc: new CrmMirrorService(prisma, fieldMap), client, call, saved, state: () => state };
}
const portal = { id: 'p1', domain: 'p.test' } as Portal;

describe('Копия CRM: первичная загрузка сделок', () => {
  it('по возрастанию ID, частями, с полями сопоставления; конец — отметка о готовности', async () => {
    const t = setup(1020);
    expect(await t.svc.backfillDeals(portal, t.client)).toBe(false);
    expect(t.state()).toMatchObject({ backfillCursor: 1000, backfillDoneAt: null });
    expect(String(t.state().fieldsKey)).toContain('UF_CRM_END');
    expect(t.call.mock.calls[0][1]).toMatchObject({ order: { ID: 'ASC' }, start: -1, select: expect.arrayContaining(['UF_CRM_END', 'STAGE_SEMANTIC_ID']) });
    expect(await t.svc.backfillDeals(portal, t.client)).toBe(true);
    expect(t.state().backfillDoneAt).toBeInstanceOf(Date);
    expect(new Set(t.saved).size).toBe(1020);
  });
});
