import { activityKind, DealHubService, plainText } from './deal-hub.service.js';

function setup() {
  const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'crm.deal.get')
      return { result: { ID: '9842', TITLE: 'Баня, суббота', CATEGORY_ID: '3', STAGE_ID: 'C3:NEW', STAGE_SEMANTIC_ID: 'P', OPPORTUNITY: '25000', CURRENCY_ID: 'RUB', ASSIGNED_BY_ID: '5', CONTACT_ID: '30468', COMPANY_ID: '0', DATE_CREATE: '2026-10-20T10:00:00+03:00' } };
    if (method === 'crm.deal.contact.items.get') return { result: [{ CONTACT_ID: '30468' }, { CONTACT_ID: '30470' }] };
    if (method === 'crm.deal.add') return { result: 9900, params };
    throw new Error(method);
  });
  const batch = vi.fn(async () => ({
    result: {
      stages: [{ STATUS_ID: 'C3:NEW', NAME: 'Новая', SEMANTICS: null }, { STATUS_ID: 'C3:WON', NAME: 'Оплачено', SEMANTICS: 'S' }],
      history: { items: [{ ID: '2', TYPE_ID: '2', STAGE_ID: 'C3:WON', CREATED_TIME: '2026-10-22T09:00:00+03:00' }, { ID: '1', TYPE_ID: '1', STAGE_ID: 'C3:NEW', CREATED_TIME: '2026-10-20T10:00:00+03:00' }] },
      activities: [{ ID: '77', TYPE_ID: '2', PROVIDER_ID: 'VOXIMPLANT_CALL', SUBJECT: 'Входящий звонок', DIRECTION: '1', CREATED: '2026-10-21T12:00:00+03:00', RESPONSIBLE_ID: '6' }],
      comments: [{ ID: '9', CREATED: '2026-10-21T13:00:00+03:00', AUTHOR_ID: '5', COMMENT: '[b]Клиент[/b] просит баню 6[br]на 18:00' }],
      contact: { NAME: 'Ольга', LAST_NAME: 'Иванова', PHONE: [{ VALUE: '+79150935422' }] },
    },
    errors: {},
  }));
  const listAll = vi.fn(async () => [{ ID: '5', NAME: 'Анна', LAST_NAME: 'Менеджер' }, { ID: '6', NAME: 'Пётр' }]);
  const prisma = { actionLog: { findMany: vi.fn(async () => [{ id: 'a1', at: new Date('2026-10-23T08:00:00Z'), actorKind: 'user', userId: 5, actorName: 'Анна Менеджер', summary: 'Создал бронь #5978 (сделка #9842)' }]) } };
  const actions = { user: vi.fn(async () => undefined) };
  const user = { portal: { id: 'p1' }, userId: 7, client: { call, batch, listAll } };
  return { svc: new DealHubService(prisma as never, actions as never), call, batch, prisma, actions, user: user as never };
}

describe('Встройка сделки: карточка, таймлайн, новая сделка', () => {
  it('карточка и таймлайн из стадий, дел, комментариев и журнала приложения — новые сверху', async () => {
    const t = setup();
    const o = await t.svc.overview(t.user, 9842);
    expect(o.deal).toMatchObject({ title: 'Баня, суббота', stage: { name: 'Новая', semantics: 'P' }, opportunity: 25000, assigned: { id: 5, name: 'Анна Менеджер' } });
    expect(o.contact).toEqual({ id: 30468, name: 'Ольга Иванова', phones: ['+79150935422'] });
    expect(o.timeline.map((x) => x.kind)).toEqual(['app', 'stage', 'comment', 'call', 'created']);
    expect(o.timeline[1].title).toBe('Стадия: Оплачено');
    expect(o.timeline[2]).toMatchObject({ actor: { id: 5, name: 'Анна Менеджер' }, text: 'Клиент просит баню 6\nна 18:00' });
    expect(o.timeline[3]).toMatchObject({ direction: 'in', actor: { id: 6, name: 'Пётр' } });
    // Журнал — только этого портала: сама сделка и её брони.
    expect(t.prisma.actionLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ portalId: 'p1' }) }));
  });

  it('новая сделка — все контакты исходной, её воронка; ответственный — сотрудник; в журнал', async () => {
    const t = setup();
    expect(await t.svc.newDeal(t.user, 9842)).toEqual({ id: 9900 });
    expect(t.call).toHaveBeenCalledWith('crm.deal.add', { fields: { CATEGORY_ID: 3, ASSIGNED_BY_ID: 7, CONTACT_IDS: [30468, 30470] } });
    expect(t.actions.user).toHaveBeenCalledWith(t.user, expect.objectContaining({ action: 'deal.create', entityId: '9900' }));
  });

  it('вид дела и текст без BB-кодов', () => {
    expect(activityKind({ PROVIDER_ID: 'IMOPENLINES_SESSION', TYPE_ID: '6' })).toBe('chat');
    expect(activityKind({ PROVIDER_ID: 'CRM_TODO', TYPE_ID: '6' })).toBe('activity');
    expect(activityKind({ TYPE_ID: '4' })).toBe('email');
    expect(plainText('<p>Привет</p>[url=x]ссылка[/url]')).toBe('Приветссылка');
  });
});
