import { MessengerConnectorService, lineUser } from './messenger-connector.service.js';
import { MessengerCrmService, telegramIdOf } from './messenger-crm.service.js';
import type { InboxListener } from './messenger-inbox.service.js';
import type { Messenger, MessengerMessage } from '../../generated/prisma/client.js';
import { resetLineHealthCache } from '../openlines/line-health.js';

const TG = { id: 'm1', portalId: 'p1', kind: 'telegram', lineMode: 'own', lineId: 16 } as Messenger;

describe('клиент CRM для Telegram без номера', () => {
  function crmSetup(chat: Record<string, unknown> | null, contacts: Record<string, unknown>[] = []) {
    const row = chat ? { portalId: 'p1', messengerId: 'm1', chatId: '345781378@lid', phone: null, activeDealId: null, crmContactId: null, crmMatchedAt: null, crmMatch: null, ...chat } : null;
    const db = {
      portal: { findFirst: vi.fn(async () => ({ id: 'p1', status: 'ACTIVE' })) },
      messengerChat: {
        findUnique: vi.fn(async () => row),
        upsert: vi.fn(async ({ create }: { create: object }) => create),
        updateMany: vi.fn(async ({ data }: { data: object }) => (row && Object.assign(row, data), { count: 1 })),
      },
    };
    const client = {
      call: vi.fn(async (method: string, p: Record<string, unknown>) => {
        if (method === 'crm.duplicate.findbycomm') return { result: p.type === 'EMAIL' ? { CONTACT: [34534] } : {} };
        if (method === 'crm.contact.list' && (p.filter as Record<string, unknown>).UF_CRM_TELEGRAMID_WZ) return { result: contacts };
        if (method === 'crm.contact.list') return { result: ((p.filter as Record<string, number[]>)['@ID'] ?? []).map((id) => ({ ID: String(id), NAME: `К${id}` })) };
        if (method === 'crm.deal.list') return { result: [{ ID: '15074', TITLE: 'Сделка', CONTACT_ID: '34534', STAGE_SEMANTIC_ID: 'P' }] };
        if (method === 'crm.deal.get') return { result: { ID: String(p.id), CONTACT_ID: p.id === 1 ? null : '34534', STAGE_SEMANTIC_ID: p.id === 2 ? 'S' : 'P' } };
        throw new Error(method);
      }),
    };
    return { crm: new MessengerCrmService(db as never, { clientFor: () => client } as never), db, client, row };
  }

  it('ID чата Telegram — ID пользователя; у групп и WhatsApp — нет', () => {
    expect(telegramIdOf('telegram', '345781378@lid')).toBe('345781378');
    expect(telegramIdOf('telegram', '5225149448@g.us')).toBeNull();
    expect(telegramIdOf('whatsapp', '345781378@lid')).toBeNull();
  });

  it('находит старого клиента по почте и полю прежнего провайдера; поле, неизвестное порталу, не даёт всех контактов', async () => {
    // Поле не применилось (портал вернул чужие контакты без значения) — их не берём.
    const t = crmSetup({}, [{ ID: '20' }, { ID: '24', UF_CRM_TELEGRAMID_WZ: '999' }]);
    expect(await t.crm.route(TG, '345781378@lid')).toEqual({ dealId: 15074, awaitingDeal: false });
    expect(t.client.call).toHaveBeenCalledWith('crm.duplicate.findbycomm', { type: 'EMAIL', values: ['345781378@telegram.wazzup'] });
    expect(t.client.call).not.toHaveBeenCalledWith('crm.duplicate.findbycomm', expect.objectContaining({ type: 'PHONE' }));
    expect(t.row?.crmContactId).toBe(34534);
  });

  it('связанный из сделки клиент сохраняется при повторном поиске', async () => {
    const t = crmSetup({ crmContactId: 777 });
    t.client.call.mockImplementation(async (method: string, p: Record<string, unknown>) => {
      if (method === 'crm.duplicate.findbycomm') return { result: {} };
      if (method === 'crm.contact.list' && (p.filter as Record<string, unknown>).UF_CRM_TELEGRAMID_WZ) return { result: [] };
      if (method === 'crm.contact.list') return { result: [{ ID: '777' }] };
      if (method === 'crm.deal.list') return { result: [] };
      throw new Error(method);
    });
    await t.crm.route(TG, '345781378@lid');
    expect(t.client.call).toHaveBeenCalledWith('crm.contact.list', expect.objectContaining({ filter: { '@ID': [777] } }));
    expect(t.row?.crmContactId).toBe(777);
  });

  it('новый чат из сделки: нужен контакт; закрытая сделка не становится выбранной', async () => {
    const t = crmSetup(null);
    const user = { client: t.client } as never;
    await expect(t.crm.linkForDeal(user, 1)).rejects.toMatchObject({ status: 400 });
    expect(await t.crm.linkForDeal(user, 2)).toEqual({ dealId: null, contactId: 34534 });
    expect(await t.crm.linkForDeal(user, 15074)).toEqual({ dealId: 15074, contactId: 34534 });
  });
});

describe('новый диалог линии — к найденному клиенту', () => {
  const msg = { id: 'row', externalId: 'ext', chatId: '345781378@lid', dealId: 15074, relayChatId: null, body: 'Привет', sentAt: new Date(), awaitingDeal: false, mediaId: null, fromMe: false, type: 'chat', hasMedia: false } as unknown as MessengerMessage;
  function setup(rivalConfigured: boolean) {
    resetLineHealthCache();
    let listener!: InboxListener;
    const call = vi.fn(async (method: string, _p: Record<string, unknown>): Promise<{ result: unknown }> => {
      if (method === 'imopenlines.crm.chat.get') return { result: [{ CHAT_ID: '22164' }] };
      if (method === 'imopenlines.dialog.get') return { result: { entity_id: 'wz_telegram_abc|8|x|1' } };
      if (method === 'imopenlines.config.list.get') return { result: [{ ID: 8, ACTIVE: 'Y' }] };
      if (method === 'imconnector.status') return { result: { CONFIGURED: rivalConfigured, STATUS: rivalConfigured } };
      return { result: { SUCCESS: true, DATA: { RESULT: [{ SUCCESS: true, session: { CHAT_ID: '900' } }] } } };
    });
    const db = {
      portal: { findFirst: vi.fn(async () => ({ id: 'p1', status: 'ACTIVE' })) },
      messenger: { findFirst: vi.fn(async () => null) },
      messengerMessage: { findFirst: vi.fn(async () => null), update: vi.fn() },
      messengerChat: { findUnique: vi.fn(async () => ({ id: 'c', phone: null, name: 'Taya', crmContactId: 34534, crmMatch: { dealIds: [15074] } })) },
    };
    const crm = { comms: vi.fn(async () => ({ phone: '+79256863020', email: '345781378@telegram.wazzup' })) };
    const svc = new MessengerConnectorService(db as never, { clientFor: () => ({ call }) } as never, { avatar: async () => null } as never, { listen: (l: InboxListener) => { listener = l; } } as never, {} as never, { url: () => null } as never, crm as never);
    svc.onModuleInit();
    return { svc, call, incoming: () => listener.incoming(TG, msg, 'Taya') };
  }
  const sent = (call: ReturnType<typeof setup>['call']) => call.mock.calls.find(([method]) => method === 'imconnector.send.messages');

  it('все прежние чаты клиента не работают — сообщение сразу в линию с телефоном и почтой клиента, CRM-трекер включён', async () => {
    const t = setup(false);
    try {
      await t.incoming();
      const payload = sent(t.call)?.[1] as { MESSAGES: { user: Record<string, unknown>; message: Record<string, unknown> }[] };
      expect(payload.MESSAGES[0].user).toMatchObject({ phone: '+79256863020', email: '345781378@telegram.wazzup' });
      expect(payload.MESSAGES[0].message.disable_crm).toBeUndefined();
    } finally {
      t.svc.onApplicationShutdown();
    }
  });

  it('у клиента есть рабочий чат — новый канал ждёт выбора сотрудника', async () => {
    const t = setup(true);
    try {
      await t.incoming();
      expect(sent(t.call)).toBeUndefined();
    } finally {
      t.svc.onApplicationShutdown();
    }
  });

  it('номер мессенджера важнее номера из CRM', () => {
    expect(lineUser('79990000000', { phone: '+79256863020', email: null })).toEqual({ phone: '+79990000000', skip_phone_validate: 'Y' });
    expect(lineUser(null, null)).toEqual({});
  });
});
