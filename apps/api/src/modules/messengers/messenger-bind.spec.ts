import { MessengerChatsService } from './messenger-chats.service.js';

/** «Привязать чат» и «Присоединиться к чату» во встройке сделки: клиенту ничего не отправляется. */
function setup(o: { chatContact?: number | null; dialogContact?: number | null; otherDeals?: { ID: string; TITLE: string }[] } = {}) {
  const wa = { id: 'm1', portalId: 'p1', kind: 'whatsapp', phone: '74993257916', groupIds: ['g1'], lineMode: 'own', lineId: 18, state: 'ready', auth: 'code', createdAt: new Date(), connectedAt: null };
  const tg = { ...wa, id: 'm2', kind: 'telegram', phone: '79895793606', lineId: 16 };
  const chatRow = { messengerId: 'm1', chatId: '79990001122@c.us', phone: '79990001122', name: 'Анна', lastMessageAt: new Date(), lastText: 'Привет', unread: 0, crmContactId: o.chatContact ?? null };
  const db = {
    messenger: { findMany: vi.fn(async () => [wa, tg]), findFirst: vi.fn(async () => wa) },
    messengerChat: {
      findUnique: vi.fn(async () => chatRow),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => Array.from({ length: 11 }, (_, i) => ({ ...chatRow, chatId: `7999000${i}@c.us` }))),
    },
    messengerMessage: { findFirst: vi.fn(async () => (o.dialogContact ? { b24ChatId: 501 } : null)) },
    chatLineChannel: { findUnique: vi.fn(async () => ({ channel: 'whatsapp:74993257916' })) },
  };
  const call = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'crm.deal.get') return { result: { ID: String(params.id), CONTACT_ID: '140', STAGE_SEMANTIC_ID: 'P' } };
    if (method === 'crm.contact.get') return { result: { NAME: 'Анна', PHONE: [{ VALUE: '+7 999 000-11-22' }] } };
    if (method === 'crm.contact.list') return { result: [{ ID: '140', NAME: 'Анна' }, { ID: '777', NAME: 'Анна (дубль)' }] };
    if (method === 'crm.deal.list') return { result: o.otherDeals ?? [] };
    if (method === 'imopenlines.dialog.get' && params.CHAT_ID === 501) return { result: { id: 501, entity_data_2: `CONTACT|${o.dialogContact}` } };
    if (method === 'imopenlines.dialog.get') return { result: { id: params.CHAT_ID, entity_id: 'wz_whatsapp|2|uuid|1', entity_data_2: 'CONTACT|140|DEAL|13440' } };
    return { result: null };
  });
  const user = { portal: { id: 'p1' }, userId: 7, client: { call } };
  const access = { resolve: vi.fn(async () => ({ isAppAdmin: true, groups: [] })) };
  const service = { contact: vi.fn(async () => ({ exists: true, chatId: '79990001122@c.us' })), send: vi.fn() };
  const crm = { linkForDeal: vi.fn(async (_u: unknown, dealId: number) => ({ dealId, contactId: 140 })), pin: vi.fn(async () => undefined), contactFields: vi.fn(async () => ({})) };
  const svc = new MessengerChatsService(db as never, service as never, {} as never, {} as never, access as never, crm as never);
  return { svc, db, user, crm, service, call, wa };
}

describe('Встройка сделки: продолжить неработающий чат', () => {
  it('только наш номер, сопоставленный с линией чата; клиент — контакт чата', async () => {
    const t = setup();
    const r = await t.svc.chatTargets(t.user as never, 9001);
    expect(r).toMatchObject({ chatId: 9001, dealId: 13440, channel: 'whatsapp:74993257916', contact: { id: 140 } });
    expect(r.targets.map((x) => x.messenger.id)).toEqual(['m1']);
    expect(r.targets[0]).toMatchObject({ status: 'found', to: '79990001122@c.us' });
    expect(t.db.chatLineChannel.findUnique).toHaveBeenCalledWith({ where: { portalId_lineId: { portalId: 'p1', lineId: 2 } } });
    expect(t.service.send).not.toHaveBeenCalled();
  });
  it('линия без сопоставления — все номера', async () => {
    const t = setup();
    t.db.chatLineChannel.findUnique.mockResolvedValueOnce({ channel: 'line:2' });
    const r = await t.svc.chatTargets(t.user as never, 9001);
    expect(r.channel).toBeNull();
    expect(r.targets.map((x) => x.messenger.id)).toEqual(['m1', 'm2']);
  });
});

describe('Встройка сделки: привязать чат', () => {
  it('список — по 10, без групп, со следующей страницей', async () => {
    const t = setup();
    const r = await t.svc.bindChats(t.user as never, 'm1', ' Анна ', 20);
    expect(r.items).toHaveLength(10);
    expect(r).toMatchObject({ hasMore: true, nextOffset: 30 });
    expect(t.db.messengerChat.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 20, take: 11, where: expect.objectContaining({ messengerId: 'm1', NOT: { chatId: { endsWith: '@g.us' } } }) }));
  });
  it('свободный чат привязывается к контакту сделки', async () => {
    const t = setup();
    const r = await t.svc.bindChat(t.user as never, t.wa as never, '79990001122@c.us', 13440);
    expect(r).toMatchObject({ linked: true, merge: null });
    expect(t.crm.pin).toHaveBeenCalledWith(t.wa, '79990001122@c.us', { dealId: 13440, contactId: 140 }, '79990001122');
  });
  it('у клиента другие сделки в работе — привязан, но подсказка объединить сделки', async () => {
    const t = setup({ otherDeals: [{ ID: '13440', TITLE: 'Эта' }, { ID: '13500', TITLE: 'Баня 5 ноября' }] });
    const r = await t.svc.bindChat(t.user as never, t.wa as never, '79990001122@c.us', 13440);
    expect(r.linked).toBe(true);
    expect(r.merge).toEqual({ contacts: [], deals: [{ id: 13500, title: 'Баня 5 ноября' }] });
  });
  it('чат уже у другого контакта (в приложении или диалог линии) — не привязываем, просим объединить контакты', async () => {
    for (const o of [{ chatContact: 777 }, { dialogContact: 777 }]) {
      const t = setup(o);
      const r = await t.svc.bindChat(t.user as never, t.wa as never, '79990001122@c.us', 13440);
      expect(r.linked).toBe(false);
      expect(r.message).toContain('Объедините контакты');
      expect(r.merge?.contacts.map((c) => c.id)).toEqual([140, 777]);
      expect(t.crm.pin).not.toHaveBeenCalled();
    }
  });
  it('группу мессенджера не привязать', async () => {
    const t = setup();
    await expect(t.svc.bindChat(t.user as never, t.wa as never, '1203@g.us', 13440)).rejects.toMatchObject({ status: 400 });
  });
});
