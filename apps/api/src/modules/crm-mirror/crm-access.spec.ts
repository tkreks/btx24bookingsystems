import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { CRM_ACCESS_TTL_MS, CrmAccessService } from './crm-access.service.js';

/** База ответов: строки CrmAccessCheck (запись — через $executeRaw). */
function fakeDb(rows: { userId: number; entityTypeId: number; entityId: number; allowed: boolean; checkedAt: Date }[] = []) {
  return {
    rows,
    prisma: {
      crmAccessCheck: {
        findMany: vi.fn(async ({ where }: { where: { userId: number; entityTypeId: number; entityId: { in: number[] } } }) =>
          rows.filter((r) => r.userId === where.userId && r.entityTypeId === where.entityTypeId && where.entityId.in.includes(r.entityId))),
        deleteMany: vi.fn(async () => ({ count: 0 })),
      },
      $executeRaw: vi.fn(async () => 1),
    } as unknown as PrismaService,
  };
}

/** Портал «видит» сотруднику сделки 1 и 3, контакт 10; остальное — нет. */
function setup(userId = 7, db = fakeDb()) {
  const visible: Record<string, number[]> = { 'crm.deal.list': [1, 3], 'crm.contact.list': [10], 'crm.lead.list': [], 'crm.company.list': [] };
  const batch = vi.fn(async (commands: Record<string, { method: string; params: { filter: { '@ID': number[] }; select: string[] } }>) => ({
    result: Object.fromEntries(Object.entries(commands).map(([k, c]) => [k, c.params.filter['@ID'].filter((id) => visible[c.method].includes(id)).map((ID) => ({ ID: String(ID) }))])),
    errors: {} as Record<string, { error: string }>,
    total: {},
    next: {},
  }));
  const user = { portal: { id: 'p1' }, userId, client: { batch } } as unknown as B24UserContext;
  const svc = new CrmAccessService(db.prisma);
  let t = 1_000_000;
  svc.now = () => t;
  return { svc, user, batch, db, tick: (ms: number) => (t += ms), visible };
}

describe('Права на записи копии CRM — токеном сотрудника', () => {
  it('видно только то, что портал вернул его токеном; запрос — только номера', async () => {
    const s = setup();
    const ok = await s.svc.visibleMany(s.user, [{ typeId: 2, id: 1 }, { typeId: 2, id: 2 }, { typeId: 2, id: 3 }, { typeId: 3, id: 10 }, { typeId: 3, id: 11 }]);
    expect([...ok.get(2)!]).toEqual([1, 3]);
    expect([...ok.get(3)!]).toEqual([10]);
    const cmds = Object.values(s.batch.mock.calls[0][0]);
    expect(cmds.every((c) => JSON.stringify(c.params.select) === '["ID"]')).toBe(true);
  });

  it('старше 5 минут — показ сразу по прежнему ответу, перепроверка в фоне', async () => {
    const s = setup();
    await s.svc.visible(s.user, 2, [1, 2]);
    s.tick(CRM_ACCESS_TTL_MS - 1);
    expect([...(await s.svc.visible(s.user, 2, [1, 2]))]).toEqual([1]);
    expect(s.batch).toHaveBeenCalledTimes(1);
    s.tick(2);
    // Права на сделку 1 сняли: этот ответ — ещё по прежнему, фоновая проверка узнаёт новое.
    s.visible['crm.deal.list'] = [3];
    expect([...(await s.svc.visible(s.user, 2, [1, 2]))]).toEqual([1]);
    expect(s.batch).toHaveBeenCalledTimes(2);
    await new Promise((r) => setTimeout(r, 0));
    expect((await s.svc.visible(s.user, 2, [1, 2])).size).toBe(0);
  });

  it('ответы хранятся в базе: через 3 дня — данные сразу, без ожидания портала', async () => {
    const db = fakeDb([{ userId: 7, entityTypeId: 2, entityId: 1, allowed: true, checkedAt: new Date(1_000_000 - 3 * 86_400_000) }]);
    const s = setup(7, db);
    expect([...(await s.svc.visible(s.user, 2, [1]))]).toEqual([1]);
    // Портал спрошен в фоне, ответ записан.
    expect(s.batch).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(db.prisma.$executeRaw).toHaveBeenCalled();
  });

  it('ошибка проверки — не видно и не запоминается; неизвестный тип — не видно', async () => {
    const s = setup();
    s.batch.mockResolvedValueOnce({ result: {}, errors: { t2_0: { error: 'ACCESS_DENIED' } }, total: {}, next: {} });
    expect((await s.svc.visible(s.user, 2, [1])).size).toBe(0);
    expect([...(await s.svc.visible(s.user, 2, [1]))]).toEqual([1]);
    expect((await s.svc.visible(s.user, 128, [5])).size).toBe(0);
  });

  it('у каждого сотрудника — свои проверки', async () => {
    const a = setup(7);
    await a.svc.visible(a.user, 2, [1]);
    const other = { ...a.user, userId: 8 } as B24UserContext;
    await a.svc.visible(other, 2, [1]);
    expect(a.batch).toHaveBeenCalledTimes(2);
  });

  it('номера — по 50 в команде', async () => {
    const s = setup();
    await s.svc.visible(s.user, 2, Array.from({ length: 120 }, (_, i) => i + 1));
    expect(Object.values(s.batch.mock.calls[0][0]).map((c) => c.params.filter['@ID'].length)).toEqual([50, 50, 20]);
  });
});
