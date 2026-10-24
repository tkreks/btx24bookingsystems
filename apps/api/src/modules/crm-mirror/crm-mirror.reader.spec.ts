import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { CrmAccessService } from './crm-access.service.js';
import { CrmMirrorReader } from './crm-mirror.reader.js';

function setup() {
  const deals = [1, 2, 3].map((dealId) => ({ dealId, row: { ID: String(dealId), TITLE: `Сделка ${dealId}` }, deletedAt: null as Date | null }));
  const calls = [
    { row: { ID: '100', OWNER_TYPE_ID: '2', OWNER_ID: '1' } },
    { row: { ID: '101', OWNER_TYPE_ID: '2', OWNER_ID: '2' } },
    { row: { ID: '102', OWNER_TYPE_ID: '3', OWNER_ID: '10' } },
    // Владелец — тип 14 (не сделка/лид/контакт/компания): виден по клиенту звонка.
    { row: { ID: '103', OWNER_TYPE_ID: '14', OWNER_ID: '9310', COMMUNICATIONS: [{ ENTITY_TYPE_ID: '3', ENTITY_ID: '10' }] } },
    { row: { ID: '104', OWNER_TYPE_ID: '14', OWNER_ID: '9311', COMMUNICATIONS: [{ ENTITY_TYPE_ID: '3', ENTITY_ID: '11' }] } },
  ];
  const prisma = {
    crmDeal: { findMany: vi.fn(async (q: { where: { dealId?: { in: number[] } }; skip?: number }) => ((q.skip ?? 0) > 0 ? [] : deals.filter((d) => !q.where.dealId || q.where.dealId.in.includes(d.dealId)))) },
    crmCall: { findMany: vi.fn(async (q: { skip?: number }) => ((q.skip ?? 0) > 0 ? [] : calls)) },
    crmSyncState: { findUnique: vi.fn(async () => ({ backfillDoneAt: new Date(), fieldsKey: 'ID,TITLE,UF_CRM_X' })) },
  } as unknown as PrismaService;
  // Сотруднику видны сделки 1 и 3 и контакт 10.
  const seen: Record<number, number[]> = { 2: [1, 3], 3: [10] };
  const access = {
    visible: vi.fn(async (_u: unknown, typeId: number, ids: number[]) => new Set(ids.filter((id) => seen[typeId]?.includes(id)))),
    visibleMany: vi.fn(async (_u: unknown, refs: { typeId: number; id: number }[]) => {
      const out = new Map<number, Set<number>>();
      for (const r of refs) if (seen[r.typeId]?.includes(r.id)) (out.get(r.typeId) ?? out.set(r.typeId, new Set()).get(r.typeId)!).add(r.id);
      return out;
    }),
  } as unknown as CrmAccessService;
  const user = { portal: { id: 'p1' }, userId: 7 } as unknown as B24UserContext;
  return { reader: new CrmMirrorReader(prisma, access), user, prisma };
}

describe('Копия CRM: чтение с правами сотрудника', () => {
  it('сделки — только видимые ему', async () => {
    const t = setup();
    expect((await t.reader.deals(t.user, {})).map((r) => r.ID)).toEqual(['1', '3']);
  });
  it('по номерам: невидимой нет, отсутствующая в копии — «спросить портал»', async () => {
    const t = setup();
    const r = await t.reader.dealsByIds(t.user, [1, 2, 9]);
    expect(r.rows.map((x) => x.ID)).toEqual(['1']);
    expect(r.missing).toEqual([9]);
  });
  it('звонок виден, если видна хоть одна привязка (владелец или клиент)', async () => {
    const t = setup();
    expect((await t.reader.calls(t.user, {}, 100)).rows.map((r) => r.ID)).toEqual(['100', '102', '103']);
  });
  it('готовность сделок — только если в копии есть нужные поля', async () => {
    const t = setup();
    expect(await t.reader.ready('p1', 'deal', ['UF_CRM_X'])).toBe(true);
    expect(await t.reader.ready('p1', 'deal', ['UF_CRM_Y'])).toBe(false);
  });
});
