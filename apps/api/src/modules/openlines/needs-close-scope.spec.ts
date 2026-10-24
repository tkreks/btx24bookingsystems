import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import type { BookingJournalService } from '../bookings/booking-journal.service.js';
import type { DealStatusService } from '../bookings/deal-status.service.js';
import type { ChatsService } from './chats.service.js';
import { DashboardService } from './dashboard.service.js';

function setup(portalId = 'p1') {
  const activeListBetween = vi.fn(async () => [1, 2].map((id) => ({ dealId: id, endsAt: new Date('2026-01-01') })));
  const endedForClosing = vi.fn(activeListBetween);
  const journal = { activeListBetween, endedForClosing } as unknown as BookingJournalService;
  const statuses = { forDeals: vi.fn(async () => new Map([1,2].map((id) => [id, { needsClose: true, bookingEnd: '2026-01-01' }]))), selectFields: async () => [], fromRows: async () => new Map() } as unknown as DealStatusService;
  const listAll = vi.fn(async (method: string, params: { filter: Record<string, unknown> }) => {
    if (method !== 'crm.deal.list') return [];
    return [1,2].filter((id) => params.filter.ASSIGNED_BY_ID === undefined || id === 1).map((ID) => ({ ID: String(ID), TITLE: `Сделка ${ID}`, CONTACT_ID: '0', ASSIGNED_BY_ID: ID === 1 ? '7' : '8' }));
  });
  const user = { portal: { id: portalId, timezone: 'Europe/Moscow' }, userId: 7, client: { listAll } } as unknown as B24UserContext;
  const svc = new DashboardService({} as ChatsService, journal, undefined, undefined, statuses);
  return { svc, user, listAll, activeListBetween, endedForClosing, statuses };
}
describe('Сделки к закрытию: ответственный и доступ', () => {
  it('по умолчанию — ответственный текущий сотрудник', async () => {
    const t = setup();
    expect((await t.svc.needsClose(t.user, [10])).items.map((i) => i.dealId)).toEqual([1]);
    expect(t.listAll).toHaveBeenCalledWith('crm.deal.list', expect.objectContaining({ filter: { '@ID': [1,2] } }));
  });
  it('собственная сделка за пределами первых 200 кандидатов не теряется', async () => {
    const t = setup();
    t.endedForClosing.mockResolvedValue(Array.from({ length: 201 }, (_, i) => ({ dealId: i + 1, endsAt: new Date('2026-01-01') })));
    t.listAll.mockImplementation(async (method) => method === 'crm.deal.list' ? [{ ID: '201', TITLE: 'Моя поздняя сделка', CONTACT_ID: '0', ASSIGNED_BY_ID: '7' }] : []);
    vi.mocked(t.statuses.forDeals).mockResolvedValue(new Map([[201, { needsClose: true, bookingEnd: '2026-01-01' } as never]]));
    expect((await t.svc.needsClose(t.user, [10])).items.map((i) => i.dealId)).toEqual([201]);
  });

  it('игнорирует выбранный день и считает обе вкладки за всё время', async () => {
    const t = setup();
    const result = await t.svc.needsClose(t.user, [10], 'all', { from: '2026-10-24', to: '2026-10-24' });
    expect(result.counts).toEqual({ mine: 1, all: 2 });
    expect(t.endedForClosing).toHaveBeenCalledWith('p1', expect.any(Date), [10]);
  });

  it.each(['p1','p2'])('Все — без фильтра ответственного, с ограничением портала %s и ресурсов', async (portalId) => {
    const t = setup(portalId);
    expect((await t.svc.needsClose(t.user, [10], 'all')).items.map((i) => i.dealId)).toEqual([1,2]);
    expect(t.listAll).toHaveBeenCalledWith('crm.deal.list', expect.objectContaining({ filter: { '@ID': [1,2] } }));
    expect(t.endedForClosing).toHaveBeenCalledWith(portalId, expect.any(Date), [10]);
  });
});
