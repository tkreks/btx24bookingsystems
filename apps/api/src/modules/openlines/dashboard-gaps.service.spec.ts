import { ForbiddenException } from '@nestjs/common';
import type { AccessService } from '../access/access.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { DashboardGapsController, DashboardGapsService } from './dashboard-gaps.service.js';

type BatchResponse = { result: Record<string, unknown>; errors: Record<string, { error: string }> };

function setup() {
  const listAll = vi.fn(async () => [
    { ID: '10', TITLE: 'Чат у контакта', CONTACT_ID: '140', CATEGORY_ID: '0' },
    { ID: '11', TITLE: 'Нет клиента', CONTACT_ID: '0', CATEGORY_ID: '0' },
    { ID: '12', TITLE: 'Чат недоступен', CONTACT_ID: '150', CATEGORY_ID: '0' },
    { ID: '13', TITLE: 'Чужая группа', CONTACT_ID: '0', CATEGORY_ID: '14' },
  ]);
  const batch = vi.fn(async (_commands: Record<string, unknown>): Promise<BatchResponse> => ({ result: { d10: [], c140: [{ CHAT_ID: '5' }], d11: [], d12: [], c150: [] }, errors: { c150: { error: 'ACCESS_DENIED' } } }));
  const user = { portal: { id: 'p1' }, userId: 7, client: { listAll, batch } } as unknown as B24UserContext;
  return { svc: new DashboardGapsService(), user, listAll, batch };
}
describe('DashboardGapsService', () => {
  it('без линии: учитывает контакт и не считает отказ доступа отсутствием чата', async () => {
    const t = setup();
    const d = await t.svc.get(t.user, 'chat', [0]);
    expect(d.items.map((i) => i.dealId)).toEqual([11]);
    expect(d.notes).toEqual([expect.stringContaining('не удалось проверить чат')]);
    expect(t.listAll).toHaveBeenCalledWith('crm.deal.list', expect.objectContaining({ filter: { STAGE_SEMANTIC_ID: 'P', '@CATEGORY_ID': [0] } }), expect.anything());
    expect(t.batch.mock.calls[0][0]).not.toHaveProperty('d13');
  });
  it('телефоны только доступных клиентов оставшихся сделок, без дублей и с нормализацией', async () => {
    const t = setup();
    t.listAll.mockResolvedValue([
      { ID: '20', TITLE: 'Без чата', CONTACT_ID: '140', COMPANY_ID: '50', CATEGORY_ID: '0' },
      { ID: '21', TITLE: 'Чужая воронка', CONTACT_ID: '999', COMPANY_ID: '999', CATEGORY_ID: '14' },
    ] as never);
    t.batch.mockImplementation(async (commands): Promise<BatchResponse> => Object.hasOwn(commands, 'd20') ? { result: { d20: [], c140: [] }, errors: {} } : {
      result: { contact140: { PHONE: [{ VALUE: '+7 (925) 973-47-63' }, { VALUE: '89259734763' }, { VALUE: 'не телефон' }] }, company50: { PHONE: [{ VALUE: '74993467272' }] } }, errors: {},
    });
    const d = await t.svc.get(t.user, 'chat', [0]);
    expect(d.items[0].phones).toEqual(['79259734763', '74993467272']);
    expect(t.batch.mock.calls[1][0]).toEqual({ contact140: { method: 'crm.contact.get', params: { id: 140 } }, company50: { method: 'crm.company.get', params: { id: 50 } } });
    expect(t.batch.mock.calls.flatMap(c => Object.keys(c[0]))).not.toContain('contact999');
  });
  it('не раскрывает телефон при отказе CRM и сохраняет сделку при сбое загрузки телефонов', async () => {
    const t = setup();
    t.listAll.mockResolvedValue([{ ID: '20', TITLE: 'Без чата', CONTACT_ID: '140', CATEGORY_ID: '0' }]);
    t.batch.mockImplementation(async (commands): Promise<BatchResponse> => Object.hasOwn(commands, 'd20') ? { result: { d20: [], c140: [] }, errors: {} } : {
      result: { contact140: { PHONE: [{ VALUE: '79259734763' }] } }, errors: { contact140: { error: 'ACCESS_DENIED' } },
    });
    expect((await t.svc.get(t.user, 'chat', [0])).items[0].phones).toEqual([]);
    t.batch.mockImplementation(async (commands): Promise<BatchResponse> => { if (Object.hasOwn(commands, 'd20')) return { result: { d20: [], c140: [] }, errors: {} }; throw new Error('offline'); });
    const d = await t.svc.get(t.user, 'chat', [0]);
    expect(d.items[0].dealId).toBe(20);
    expect(d.items[0].phones).toEqual([]);
    expect(d.notes).toContain('Не удалось загрузить телефоны клиентов для поиска в мессенджерах.');
  });
  it('без контакта: только доступные воронки; не запрашивает открытые линии', async () => {
    const t = setup();
    expect((await t.svc.get(t.user, 'contact', [0])).items.map((i) => i.dealId)).toEqual([11]);
    expect(t.batch).not.toHaveBeenCalled();
  });
  it('без доступных воронок не обращается к CRM', async () => {
    const t = setup();
    expect((await t.svc.get(t.user, 'chat', [])).items).toEqual([]);
    expect(t.listAll).not.toHaveBeenCalled();
  });
  it('контроллер не даёт читать данные без групп или права открытых линий', async () => {
    const t = setup();
    const access = { resolve: vi.fn(async () => ({ isAppAdmin: false, groups: [] })) };
    const c = new DashboardGapsController(access as unknown as AccessService, t.svc);
    await expect(c.get(t.user, 'contact')).rejects.toBeInstanceOf(ForbiddenException);
    access.resolve.mockResolvedValue({ isAppAdmin: false, groups: [{ permissions: [], group: { dealCategoryId: 0 } }] } as never);
    await expect(c.get(t.user, 'chat')).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.listAll).not.toHaveBeenCalled();
  });
});
