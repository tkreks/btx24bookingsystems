import { DashboardService } from './dashboard.service.js';
import { CallExclusionsService } from './call-exclusions.service.js';
import type { CallActivity } from './call-stats.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import type { ChatsService } from './chats.service.js';
import type { BookingJournalService } from '../bookings/booking-journal.service.js';

const call = (id: number, contact: number, time: string, missed = true, direction = '1'): CallActivity => ({ ID: String(id), OWNER_ID: String(contact), OWNER_TYPE_ID: '3', DIRECTION: direction, START_TIME: time, END_TIME: new Date(Date.parse(time) + (missed ? 0 : 30000)).toISOString(), RESPONSIBLE_ID: '7', SETTINGS: { MISSED_CALL: missed }, COMMUNICATIONS: [{ ENTITY_TYPE_ID: 3, ENTITY_ID: contact, VALUE: '+79000000000' }] });
function setup() {
  const rows = [call(1, 10, '2026-10-22T10:00:00Z'), call(2, 20, '2026-10-22T11:00:00Z')];
  const listAll = vi.fn(async (method: string) => {
    if (method === 'crm.activity.list') return [...rows, call(3, 10, '2026-10-23T10:00:00Z', false, '2')];
    if (method === 'voximplant.statistic.get') return [{ CRM_ACTIVITY_ID: '1', PORTAL_NUMBER: '+74950000000', PORTAL_USER_ID: '8' }, { CRM_ACTIVITY_ID: '2', PORTAL_NUMBER: 'reg134', PORTAL_USER_ID: '7' }, { CRM_ACTIVITY_ID: '999', PORTAL_NUMBER: '+79990000000' }];
    if (method === 'user.get') return [{ ID: '7', NAME: 'Анна' }, { ID: '8', NAME: 'Елена', PERSONAL_PHOTO: 'https://portal.test/photo.jpg' }];
    if (method === 'crm.contact.list') return [{ ID: '10', NAME: 'Иван', PHOTO: '/upload/client10.jpg' }, { ID: '20', NAME: 'Олег', PHOTO: { showUrl: '/upload/client20.jpg' } }];
    return [];
  });
  const client = { call: vi.fn(async () => ({ result: rows })), listAll, batch: vi.fn(async () => ({ result: {} })) };
  const user = { portal: { id: 'p1', timezone: 'Europe/Moscow', domain: 'portal.test' }, userId: 7, client } as unknown as B24UserContext;
  const chats = { reachedSince: vi.fn(async () => [] as { contactId: number; phones: string[]; at: number }[]) };
  return { chats, svc: new DashboardService(chats as unknown as ChatsService, {} as BookingJournalService), user, client };
}
describe('Однострочные звонки: участники, линия, упущенные', () => {
  it('перезвон после выбранного периода снимает упущенный; номер и фактический сотрудник — из телефонии', async () => {
    const t = setup();
    const r = await t.svc.recentCalls(t.user, { from: '2026-10-22', to: '2026-10-22', scope: 'mine' });
    expect(r.items.map((c) => c.activityId)).toEqual([2,1]);
    expect(r.items.find((c) => c.activityId === 1)?.contact?.photo).toBe('https://portal.test/upload/client10.jpg');
    expect(r.items.find((c) => c.activityId === 2)?.contact?.photo).toBe('https://portal.test/upload/client20.jpg');
    expect(r.items.find((c) => c.activityId === 1)).toMatchObject({ activityId: 1, portalPhone: '+74950000000', employee: { id: 8, name: 'Елена' }, lost: false });
    expect(r.items.find((c) => c.activityId === 2)).toMatchObject({ activityId: 2, portalPhone: null, employee: { id: 7 }, lost: true });
    expect(r.items.some((c) => c.activityId === 999)).toBe(false);
    expect(t.client.call).toHaveBeenCalledWith('crm.activity.list', expect.objectContaining({ filter: expect.objectContaining({ RESPONSIBLE_ID: 7, '>=START_TIME': '2026-10-21T21:00:00.000Z', '<START_TIME': '2026-10-22T21:00:00.000Z' }) }));
    expect(t.client.listAll).toHaveBeenCalledWith('voximplant.statistic.get', expect.objectContaining({ FILTER: { CRM_ACTIVITY_ID: [2, 1] } }), { max: 200 });
  });
  it('исключённый из статистики звонок (внутренний тест) не виден в списке и не упущенный', async () => {
    const t = setup();
    const exclusions = new CallExclusionsService({ callExclusion: { findMany: vi.fn(async () => [{ activityId: 2 }]) } } as never);
    const svc = new DashboardService(t.chats as unknown as ChatsService, {} as BookingJournalService, undefined, undefined, undefined, undefined, exclusions);
    const r = await svc.recentCalls(t.user, { from: '2026-10-22', to: '2026-10-22', scope: 'mine' });
    expect(r.items.map((c) => c.activityId)).toEqual([1]);
    expect((await svc.fetchCalls(t.user, new Date('2026-10-22T00:00:00Z'))).rows.map((c) => c.ID)).toEqual(['1', '3']);
  });
  it('исключение — только с причиной, повтор обновляет причину', async () => {
    const upsert = vi.fn(async () => ({}));
    const svc = new CallExclusionsService({ callExclusion: { upsert } } as never);
    await expect(svc.exclude('p1', 7, 2, '  ')).rejects.toMatchObject({ status: 400 });
    await svc.exclude('p1', 7, 2, ' Внутренний тест ');
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { portalId_activityId: { portalId: 'p1', activityId: 2 } }, create: expect.objectContaining({ reason: 'Внутренний тест' }) }));
  });
  it('неудачный исходящий после пропущенного оставляет строку упущенной', async () => {
    const t = setup(); const original = t.client.listAll.getMockImplementation()!;
    t.client.listAll.mockImplementation(async (m) => m === 'crm.activity.list' ? [call(1, 10, '2026-10-22T10:00:00Z'), call(3, 10, '2026-10-23T10:00:00Z', true, '2')] : original(m));
    expect((await t.svc.recentCalls(t.user, {})).items.find((c) => c.activityId === 1)?.lost).toBe(true);
  });
  it('общение в чате после пропущенного снимает упущенный в строке', async () => {
    const t = setup(); t.chats.reachedSince.mockResolvedValue([{ contactId: 20, phones: [], at: Date.parse('2026-10-22T12:00:00Z') }]);
    expect((await t.svc.recentCalls(t.user, {})).items.find((c) => c.activityId === 2)?.lost).toBe(false);
  });
  it('без прав телефонии показывает сотрудника CRM без выдуманного номера; неполный список не доказывает упущенный', async () => {
    const t = setup(); const original = t.client.listAll.getMockImplementation()!;
    t.client.listAll.mockImplementation(async (m) => { if (m === 'voximplant.statistic.get') throw new Error('denied'); return original(m); });
    vi.spyOn(t.svc, 'fetchCalls').mockResolvedValue({ rows: [], truncated: true });
    const r = await t.svc.recentCalls(t.user, {});
    expect(r.items.every((c) => c.portalPhone === null && !c.lost && c.employee?.id === 7)).toBe(true);
  });
});

describe('Звонки из копии CRM (ADR 0013)', () => {
  it('копия загружена — список звонков не запрашивается у портала, права — через копию', async () => {
    const t = setup();
    const rows = [call(1, 10, '2026-10-22T10:00:00Z')];
    const mirror = {
      ready: vi.fn(async () => true),
      calls: vi.fn(async () => ({ rows, truncated: false })),
      callLines: vi.fn(async () => new Map([[1, { phone: '+74950000000', userId: 8 }]])),
      titles: vi.fn(async () => new Map([['3:10', 'Иван']])),
      contacts: vi.fn(async () => ({ found: new Map([[10, { name: 'Иван', photo: null }]]), missing: [] })),
      dealsByIds: vi.fn(async () => ({ rows: [], missing: [] })),
      hasEmployees: vi.fn(async () => true),
      employees: vi.fn(async () => new Map([[8, { name: 'Елена', photo: null }]])),
    };
    const svc = new DashboardService(t.chats as unknown as ChatsService, {} as BookingJournalService, undefined, undefined, undefined, mirror as never);
    const r = await svc.recentCalls(t.user, { scope: 'mine' });
    expect(r.items).toEqual([expect.objectContaining({ activityId: 1, portalPhone: '+74950000000', employee: expect.objectContaining({ name: 'Елена' }), contact: expect.objectContaining({ name: 'Иван' }) })]);
    expect(mirror.calls).toHaveBeenCalledWith(t.user, expect.objectContaining({ responsibleId: 7, desc: true }), 50);
    expect(t.client.call).not.toHaveBeenCalled();
    expect(t.client.listAll).not.toHaveBeenCalled();
  });
});
