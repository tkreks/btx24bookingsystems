import { DealKanbanService } from './deal-kanban.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';

function setup() {
  const mirror = {
    ready: vi.fn(async () => true),
    dealsByIds: vi.fn(async () => ({
      rows: [
        { ID: '5', TITLE: 'Баня', CATEGORY_ID: '2', STAGE_ID: 'C2:WON', CONTACT_ID: '10', ASSIGNED_BY_ID: '7', DATE_CREATE: '2026-10-25T09:00:00+03:00', OPPORTUNITY: '5000', CURRENCY_ID: 'RUB' },
      ],
      missing: [6],
    })),
    contacts: vi.fn(async () => ({ found: new Map([[10, { name: 'Иван', photo: null }]]), missing: [] })),
    employees: vi.fn(async () => new Map([[7, { name: 'Анна', photo: null }]])),
  };
  const listAll = vi.fn(async (method: string) => {
    if (method === 'crm.deal.list') return [{ ID: '6', TITLE: '', CATEGORY_ID: '2', STAGE_ID: 'C2:NEW', OPPORTUNITY: '', CONTACT_ID: '0' }];
    if (method === 'crm.status.list')
      return [
        { STATUS_ID: 'C2:WON', NAME: 'Успех', SORT: '60', EXTRA: { SEMANTICS: 'success', COLOR: '#7BD500' } },
        { STATUS_ID: 'C2:NEW', NAME: 'Новая', SORT: '10', COLOR: '#39A8EF' },
      ];
    return [];
  });
  const call = vi.fn(async () => ({ result: { categories: [{ id: 2, name: 'Бани' }] } }));
  const user = { portal: { id: 'p1' }, userId: 7, client: { listAll, call } } as unknown as B24UserContext;
  return { svc: new DealKanbanService(mirror as never), mirror, listAll, user };
}

describe('Канбан сделок показателя', () => {
  it('стадии — по порядку воронки, сделки из копии и недостающие у портала, недоступные скрыты', async () => {
    const t = setup();
    const r = await t.svc.kanban(t.user, '5,6,7,5');
    expect(t.mirror.dealsByIds).toHaveBeenCalledWith(t.user, [5, 6, 7]);
    expect(t.listAll).toHaveBeenCalledWith('crm.deal.list', expect.objectContaining({ filter: { '@ID': [6] } }));
    expect(r.funnels).toEqual([{ id: 2, name: 'Бани', stages: [
      { id: 'C2:NEW', name: 'Новая', color: '#39A8EF', semantics: 'process' },
      { id: 'C2:WON', name: 'Успех', color: '#7BD500', semantics: 'success' },
    ] }]);
    expect(r.deals).toEqual([
      expect.objectContaining({ id: 5, stageId: 'C2:WON', opportunity: 5000, contact: { id: 10, name: 'Иван' }, assigned: { id: 7, name: 'Анна', photo: null } }),
      expect.objectContaining({ id: 6, title: 'Сделка #6', opportunity: null, contact: null }),
    ]);
    expect(r.hidden).toBe(1);
  });

  it('пусто и слишком много сделок', async () => {
    const t = setup();
    expect(await t.svc.kanban(t.user, '')).toEqual({ funnels: [], deals: [], hidden: 0 });
    await expect(t.svc.kanban(t.user, Array.from({ length: 501 }, (_, i) => i + 1).join(','))).rejects.toMatchObject({ status: 400 });
  });
});
