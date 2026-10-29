import { CrmMirrorService } from './crm-mirror.service.js';
import type { Portal } from '../../generated/prisma/client.js';
const portal = { id: 'p1', domain: 'p.test' } as Portal;
function setup() {
  const rows = new Map<string, { row: Record<string, unknown>; deletedAt: Date | null }>();
  const history: Record<string, unknown>[] = [];
  const alerts = new Map<string, Record<string, unknown>>();
  const keyOf = (q: { where: { portalId_entityTypeId_entityId: { portalId: string; entityId: number } } }) => `${q.where.portalId_entityTypeId_entityId.portalId}:${q.where.portalId_entityTypeId_entityId.entityId}`;
  const tx = {
    portalSettings: { findUnique: vi.fn(async () => ({ contactSystemUserIds: [242] })) },
    portalEmployee: { findUnique: vi.fn(async () => ({ name: 'Редактор' })) },
    contactAlert: { createMany: vi.fn(async ({ data }: { data: Record<string, unknown>[] }) => { for (const row of data) alerts.set(String(row.fingerprint), row); return { count: data.length }; }) },
    crmEntity: {
      findUnique: vi.fn(async (q: Parameters<typeof keyOf>[0]) => rows.get(keyOf(q)) ?? null),
      upsert: vi.fn(async (q: Parameters<typeof keyOf>[0] & { create: Record<string, unknown>; update: Record<string, unknown> }) => { const key = keyOf(q); const next = { ...rows.get(key), ...(rows.has(key) ? q.update : q.create) } as { row: Record<string, unknown>; deletedAt: Date | null }; rows.set(key, next); return next; }),
      update: vi.fn(async (q: Parameters<typeof keyOf>[0] & { data: Record<string, unknown> }) => Object.assign(rows.get(keyOf(q))!, q.data)),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => rows.set(`${data.portalId}:${data.entityId}`, data as never)),
    },
    actionLog: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { history.push(data); return data; }) },
  };
  const db = { ...tx, $transaction: vi.fn(async (fn: (tx: unknown) => Promise<void>) => fn(tx)) };
  return { svc: new CrmMirrorService(db as never, {} as never), rows, history, tx, alerts };
}
it('сохраняет всю карточку, пользовательские поля и историю изменений без дублей при повторе', async () => {
  const t = setup();
  const initial = { ID: '7', NAME: 'Анна', PHONE: [{ VALUE: '+79990000000' }], UF_CRM_TG: '123', DATE_MODIFY: '2026-10-28T12:00:00Z', MODIFY_BY_ID: '9' };
  await t.svc.saveContact(portal, initial);
  await t.svc.saveContact(portal, { ...initial, PHONE: [{ VALUE: '+79990000000' }] });
  expect(t.history).toHaveLength(1);
  await t.svc.saveContact(portal, { ID: '7', NAME: 'Анна Иванова' });
  expect(t.rows.get('p1:7')?.row).toMatchObject({ NAME: 'Анна Иванова', UF_CRM_TG: '123', PHONE: initial.PHONE });
  expect(t.history).toHaveLength(2);
  expect(t.history[1]).toMatchObject({ actorKind: 'bitrix', entityType: 'contact', details: { changes: [{ field: 'NAME', before: 'Анна', after: 'Анна Иванова' }] } });
  await t.svc.saveContact({ ...portal, id: 'p2' }, { ID: '7', NAME: 'Другой клиент' });
  expect(t.rows.get('p1:7')?.row.NAME).toBe('Анна Иванова');
  expect(t.rows.get('p2:7')?.row.NAME).toBe('Другой клиент');
});
it('удаление сохраняет данные и единственную запись истории; старое событие не восстанавливает удалённый контакт', async () => {
  const t = setup();
  await t.svc.saveContact(portal, { ID: '7', NAME: 'Анна' });
  await t.svc.refreshContact(portal, {} as never, 7, true);
  await t.svc.refreshContact(portal, {} as never, 7, true);
  expect(t.rows.get('p1:7')?.deletedAt).toBeInstanceOf(Date);
  expect(t.rows.get('p1:7')?.row.NAME).toBe('Анна');
  expect(t.history.filter(h => h.action === 'contact.deleted_in_bitrix')).toHaveLength(1);
  const call = vi.fn();
  await t.svc.refreshContact(portal, { call } as never, 7, false, new Date(0));
  expect(call).not.toHaveBeenCalled();
});

it('старый снимок не затирает новое изменение и не восстанавливает tombstone', async () => {
  const t = setup();
  await t.svc.saveContact(portal, { ID: '7', NAME: 'Новое имя', DATE_MODIFY: '2026-10-28T12:00:00Z' });
  await t.svc.saveContact(portal, { ID: '7', NAME: 'Старое имя', DATE_MODIFY: '2026-10-27T12:00:00Z' });
  expect(t.rows.get('p1:7')?.row.NAME).toBe('Новое имя');
  expect(t.history).toHaveLength(1);
  await t.svc.refreshContact(portal, {} as never, 7, true);
  await t.svc.saveContact(portal, { ID: '7', NAME: 'Новое имя', DATE_MODIFY: '2026-10-28T12:00:00Z' });
  expect(t.rows.get('p1:7')?.deletedAt).toBeInstanceOf(Date);
});

it('начальная загрузка продолжает сохранённый курсор без отсечения после двух страниц', async () => {
  let state = { backfillCursor: 0, backfillDoneAt: null as Date | null, since: null as Date | null };
  const db = { crmSyncState: { upsert: async () => ({ ...state }), update: async ({ data }: { data: Partial<typeof state> }) => Object.assign(state, data) } };
  const service = new CrmMirrorService(db as never, {} as never);
  const saved: number[] = [];
  vi.spyOn(service, 'saveContact').mockImplementation(async (_p, row) => { saved.push(Number(row.ID)); });
  const call = vi.fn(async (_method: string, p: { filter: { '>ID': number } }) => ({ result: Array.from({ length: Math.min(50, 130 - p.filter['>ID']) }, (_, i) => ({ ID: String(p.filter['>ID'] + i + 1) })) }));
  await service.syncContacts(portal, { call } as never, true);
  expect(state.backfillCursor).toBe(100);
  expect(state.backfillDoneAt).toBeNull();
  await service.syncContacts(portal, { call } as never, true);
  expect(state.backfillDoneAt).toBeInstanceOf(Date);
  expect(saved).toHaveLength(130);
  expect(new Set(saved).size).toBe(130);
});


it('известные изменения дают предупреждение с редактором; повтор и служебные поля — без дублей', async () => {
  const t = setup();
  const row = { ID: '7', NAME: 'Анна', DATE_MODIFY: '2026-10-28T12:00:00Z', MODIFY_BY_ID: '242' };
  await t.svc.saveContact(portal, row, 'baseline');
  const next = { ...row, NAME: 'Анна И.', DATE_MODIFY: '2026-10-28T12:01:00Z' };
  await t.svc.saveContact(portal, next, 'event');
  await t.svc.saveContact(portal, next, 'event');
  expect([...t.alerts.values()]).toHaveLength(1);
  expect([...t.alerts.values()][0]).toMatchObject({ kind: 'change', actor: { accountId: 242, accountType: 'system_user', attribution: 'last_editor', application: null }, changes: [{ field: 'NAME', before: 'Анна', after: 'Анна И.' }] });
  expect(t.history[1]).toMatchObject({ userId: 242, details: { deviations: [{ field: 'NAME' }] } });
  await t.svc.saveContact(portal, { ...next, DATE_MODIFY: '2026-10-28T12:02:00Z', HAS_PHONE: 'Y' }, 'event');
  expect([...t.alerts.values()]).toHaveLength(1);
});
it('первичная загрузка/обогащение не сигнализирует об отклонении; удаление сигнализирует без ложного автора', async () => {
  const t = setup();
  await t.svc.saveContact(portal, { ID: '7', NAME: 'Анна', MODIFY_BY_ID: '242' });
  await t.svc.saveContact(portal, { ID: '7', NAME: 'Анна И.', PHONE: [{ VALUE: '123' }], MODIFY_BY_ID: '242' }, 'baseline');
  expect(t.alerts.size).toBe(0);
  await t.svc.refreshContact(portal, {} as never, 7, true);
  await t.svc.refreshContact(portal, {} as never, 7, true);
  expect(t.alerts.size).toBe(1);
  expect([...t.alerts.values()][0]).toMatchObject({ kind: 'deleted', actor: { accountId: null, attribution: 'unknown' } });
});

it('пропажа из списка — предупреждение о недоступности, а не доказанное удаление', async () => {
  const create=vi.fn(async()=>({}));const history=vi.fn(async()=>({}));const setState=vi.fn(async()=>({}));
  const tx={contactAlert:{findUnique:async()=>null,create},actionLog:{create:history}};
  const db={crmSyncState:{upsert:async()=>({backfillCursor:0}),update:setState},crmEntity:{findMany:async()=>[{entityId:7,row:{ID:'7',NAME:'Сохранённое имя'}}]},$transaction:async(fn:(t:unknown)=>Promise<void>)=>fn(tx)};
  const svc=new CrmMirrorService(db as never,{} as never);
  await svc.reconcileContacts(portal,{call:async()=>({result:[]})} as never);
  expect(create).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({portalId:'p1',contactId:7,kind:'missing'})}));
  expect(history).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({details:{deletionConfirmed:false,valuesPreserved:true}})}));
  expect(setState).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({backfillCursor:7})}));
});
