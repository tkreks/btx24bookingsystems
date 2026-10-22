import { ChatsService } from './chats.service.js';
import type { FilesService } from './files.service.js';
import type { OpenlineIndexService } from './openline-index.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { Bitrix24Error } from '../bitrix24/rest/errors.js';
import type { PrismaService } from '../../prisma/prisma.service.js';

const act = (session: number, userCode: string, responsible = 7, completed: 'Y' | 'N' = 'N') => ({
  ID: String(session),
  ASSOCIATED_ENTITY_ID: String(session),
  RESPONSIBLE_ID: String(responsible),
  COMPLETED: completed,
  LAST_UPDATED: '2026-10-21T10:00:00+03:00',
  PROVIDER_PARAMS: { USER_CODE: userCode },
});

function setup(
  opts: {
    activities?: unknown[];
    dialogs?: Record<string, unknown>;
    messages?: Record<string, unknown>;
    next?: number;
    indexed?: unknown[];
    /** Чаты в моей папке. */
    foldered?: number[];
    /** Общий кэш (несколько «сотрудников» на одной базе). */
    cache?: { chats: Map<number, Record<string, unknown>>; access: Map<string, Record<string, unknown>> };
    userId?: number;
  } = {},
) {
  const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'crm.activity.list') return { result: opts.activities ?? [], next: opts.next };
    if (method === 'im.recent.list') return { result: { items: [{ id: 'chat101', chat_id: 101, counter: 3 }, { id: 'chat999', counter: 0 }] } };
    if (method === 'im.message.add') return { result: 900 + Number(String(params?.MESSAGE).length) };
    if (method === 'im.v2.File.upload') return { result: { messageId: 800 } };
    throw new Error(method);
  });
  const batch = vi.fn(async (cmds: Record<string, { method: string }>) => ({
    result: Object.fromEntries(
      Object.keys(cmds).map((k) => [k, (cmds[k].method === 'imopenlines.dialog.get' ? opts.dialogs : opts.messages)?.[k]]),
    ),
    errors: {},
  }));
  const listAll = vi.fn(async (method: string) => {
    if (method === 'department.get')
      return [
        { ID: '1', PARENT: null },
        { ID: '2', PARENT: '1' },
        { ID: '3', PARENT: null },
      ];
    if (method === 'user.get') return [{ ID: '8' }, { ID: '9' }];
    return [];
  });
  const files = {
    loadOwned: vi.fn(
      async (_u: unknown, ids: string[]) =>
        new Map(ids.map((id) => [id, { name: `${id}.jpg`, data: Buffer.from('x') }])),
    ),
    dropUnused: vi.fn(async () => undefined),
  } as unknown as FilesService;
  const user = {
    portal: { id: 'p1' },
    userId: 7,
    departmentIds: [1],
    client: { call, batch, listAll },
  } as unknown as B24UserContext;
  const index = {
    isActive: vi.fn(async () => Boolean(opts.indexed)),
    page: vi.fn(async () => opts.indexed ?? []),
    byChat: vi.fn(async () => new Map()),
  } as unknown as OpenlineIndexService;
  // Кэш списка чатов в памяти: сводки — по чату, доступы — по сотруднику и чату.
  const chats = opts.cache?.chats ?? new Map<number, Record<string, unknown>>();
  const access = opts.cache?.access ?? new Map<string, Record<string, unknown>>();
  type W = { portalId_chatId?: { chatId: number }; portalId_userId_chatId?: { userId: number; chatId: number } };
  const prisma = {
    chatFolderItem: { findMany: vi.fn(async () => (opts.foldered ?? []).map((chatId) => ({ chatId, folderId: 'f1' }))) },
    portalSettings: { findUnique: vi.fn(async () => ({ dialogTextsEnabled: true })) },
    openlineChat: {
      findMany: vi.fn(async ({ where }: { where: { chatId: { in: number[] } } }) => where.chatId.in.flatMap((id) => (chats.has(id) ? [chats.get(id)] : []))),
      upsert: vi.fn(async ({ where, create, update }: { where: W; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const id = where.portalId_chatId!.chatId;
        chats.set(id, { ...(chats.get(id) ?? create), ...update });
      }),
    },
    openlineChatAccess: {
      findMany: vi.fn(async ({ where }: { where: { userId: number; chatId: { in: number[] } } }) =>
        where.chatId.in.flatMap((id) => (access.has(`${where.userId}:${id}`) ? [access.get(`${where.userId}:${id}`)] : [])),
      ),
      upsert: vi.fn(async ({ where, create, update }: { where: W; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const k = `${where.portalId_userId_chatId!.userId}:${where.portalId_userId_chatId!.chatId}`;
        access.set(k, { ...(access.get(k) ?? create), ...update });
      }),
    },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  } as unknown as PrismaService;
  if (opts.userId) (user as { userId: number }).userId = opts.userId;
  return { svc: new ChatsService(files, index, prisma), user, call, batch, listAll, files, index, cache: { chats, access } };
}

const client = { id: 50, name: 'Клиент', connector: true };
const op = { id: 7, name: 'Оператор' };

describe('ChatsService.list', () => {
  it('builds summaries: one chat per client, newest message first, waiting for reply when the client wrote last', async () => {
    const { svc, user, call } = setup({
      activities: [act(11, 'wa|1|A|50'), act(10, 'wa|1|A|50'), act(12, 'wa|1|B|51', 7, 'Y'), act(13, 'tg|2|C|52')],
      dialogs: {
        s11: {
          id: 101,
          name: 'Анна',
          role: 'member',
          entity_id: 'wz_whatsapp_ceacd473beec8c39f54fd7afd810cd43d|1|A|50',
          entity_data_2: 'LEAD|0|COMPANY|0|CONTACT|140|DEAL|678',
        },
        s12: { id: 102, name: 'Борис', role: 'guest', entity_id: 'wa|1|B|51', entity_data_2: '' },
        s13: undefined, // нет доступа
      },
      messages: {
        c101: {
          messages: [
            { id: 2, author_id: 0, date: '2026-10-21T12:00:00+03:00' },
            { id: 1, author_id: 50, date: '2026-10-21T11:00:00+03:00', text: '[b]Здравствуйте[/b]' },
          ],
          users: [client],
        },
        c102: {
          messages: [{ id: 5, author_id: 50, date: '2026-10-21T13:00:00+03:00', text: 'Спасибо' }],
          users: [client, op],
        },
      },
      next: 50,
    });
    const res = await svc.list(user, { scope: 'mine' });
    expect(call.mock.calls[0][1]).toMatchObject({
      filter: { PROVIDER_ID: 'IMOPENLINES_SESSION', RESPONSIBLE_ID: [7] },
      start: 0,
    });
    expect(res.nextOffset).toBe(50);
    expect(res.items.map((c) => c.chatId)).toEqual([102, 101]);
    expect(res.items[1]).toMatchObject({
      sessionId: 11,
      connector: 'wz_whatsapp',
      joined: true,
      waitingReply: true,
      lastMessage: { author: 'client', preview: 'Здравствуйте' },
      crm: { contactId: 140, dealId: 678 },
      unread: 3,
      folderId: null,
    });
    // закрытая сессия не ждёт ответа, гость — не участник
    expect(res.items[0]).toMatchObject({ joined: false, sessionClosed: true, waitingReply: false, unread: 0 });
  });

  it('chats of my folders leave the main list; ?folder= lists only them', async () => {
    const one = {
      activities: [act(11, 'wa|1|A|50'), act(12, 'wa|1|B|51')],
      dialogs: {
        s11: { id: 101, name: 'Клиент', role: 'member', entity_id: 'wa|1|A|50', entity_data_2: '' },
        s12: { id: 102, name: 'Охрана', role: 'member', entity_id: 'wa|1|B|51', entity_data_2: '' },
      },
      messages: {},
      foldered: [102],
    };
    const main = setup(one);
    expect((await main.svc.list(main.user, { scope: 'all' })).items.map((c) => c.chatId)).toEqual([101]);
    const inFolder = setup({ ...one, foldered: [102, 103], dialogs: { c102: { id: 102, name: 'Охрана', role: 'member', entity_id: 'wa|1|B|51', entity_data_2: '' }, c103: { id: 103, name: 'Ресепшн', role: 'member', entity_id: 'wa|1|C|52', entity_data_2: '' } } });
    const r = await inFolder.svc.list(inFolder.user, { scope: 'all', folder: 'f1' });
    expect(r.items.map((c) => [c.chatId, c.folderId]).sort()).toEqual([[102, 'f1'], [103, 'f1']]);
    expect(r.nextOffset).toBeNull();
  });

  it('department scope = the user plus active employees of their departments with sub-departments', async () => {
    const { svc, user, call, listAll } = setup();
    await svc.list(user, { scope: 'department' });
    expect(listAll).toHaveBeenCalledWith('user.get', { FILTER: { UF_DEPARTMENT: [1, 2], ACTIVE: true } });
    expect(call.mock.calls[0][1]).toMatchObject({ filter: { RESPONSIBLE_ID: [7, 8, 9] } });
  });

  it('all scope relies on CRM rights only, and rejects unknown scopes', async () => {
    const { svc, user, call } = setup();
    await svc.list(user, { scope: 'all', offset: '50' });
    expect(call.mock.calls[0][1]).toMatchObject({ filter: { PROVIDER_ID: 'IMOPENLINES_SESSION' }, start: 50 });
    expect((call.mock.calls[0][1] as { filter: object }).filter).not.toHaveProperty('RESPONSIBLE_ID');
    await expect(svc.list(user, { scope: 'everyone' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('ChatsService.send', () => {
  it('sends steps in order: text first, then each file as its own message, with a pause between messages', async () => {
    const { svc, user, call, files } = setup();
    const pauses: number[] = [];
    svc.sleep = async (ms) => void pauses.push(ms);
    const res = await svc.send(user, 101, {
      steps: [
        { text: 'Здравствуйте', fileIds: [] },
        { text: 'Прайс', fileIds: ['f1', 'f2'] },
        { text: '', fileIds: ['f1'] },
      ],
    });
    expect(res).toEqual({ sent: 3, messageIds: [912, 905, 800, 800, 800], error: null });
    const calls = call.mock.calls.map((c) => [c[0], c[1]]);
    expect(calls).toEqual([
      ['im.message.add', { DIALOG_ID: 'chat101', MESSAGE: 'Здравствуйте' }],
      ['im.message.add', { DIALOG_ID: 'chat101', MESSAGE: 'Прайс' }],
      ['im.v2.File.upload', { dialogId: 'chat101', fields: { name: 'f1.jpg', content: 'eA==' } }],
      ['im.v2.File.upload', { dialogId: 'chat101', fields: { name: 'f2.jpg', content: 'eA==' } }],
      ['im.v2.File.upload', { dialogId: 'chat101', fields: { name: 'f1.jpg', content: 'eA==' } }],
    ]);
    expect(pauses).toEqual([1500, 1500, 1500, 1500]);
    expect(files.dropUnused).toHaveBeenCalledWith(user, ['f1', 'f2']);
  });

  it('stops at the first failing step and reports how far it got', async () => {
    const { svc, user, call } = setup();
    svc.sleep = async () => {};
    call.mockImplementation(async (method: string) => {
      if (method === 'im.message.add' && call.mock.calls.length > 1)
        throw new Bitrix24Error('READ_ONLY_MODE', 'blocked');
      return { result: 1 };
    });
    const res = await svc.send(user, 101, {
      steps: [
        { text: 'a', fileIds: [] },
        { text: 'b', fileIds: [] },
        { text: 'c', fileIds: [] },
      ],
    });
    expect(res).toEqual({
      sent: 1,
      messageIds: [1],
      error: {
        step: 1,
        code: 'READ_ONLY_MODE',
        message: 'Изменения в Битрикс24 сейчас запрещены (режим только чтения)',
      },
    });
  });

  it.each([
    { steps: [] },
    { steps: [{ text: '  ', fileIds: [] }] },
    { steps: [{ text: 'x', fileIds: [], extra: 1 }] },
    {},
  ])('rejects an invalid chain %o', async (body) => {
    const { svc, user } = setup();
    await expect(svc.send(user, 1, body)).rejects.toMatchObject({ status: 400 });
  });
});

describe('ChatsService.list with the metadata index', () => {
  it('pages by the index, checks access with the user token and keeps the Bitrix24 order', async () => {
    const at = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 21, h - 3, m));
    const { svc, user, call, index } = setup({
      // как в списке диалогов портала: 19248 (18:05) → 19286 (17:39) → 19216 (17:29) → 19282 (16:24)
      indexed: [
        { sessionId: 19248, responsibleId: 7, completed: false, lastMessageAt: at(18, 5) },
        { sessionId: 19286, responsibleId: 7, completed: false, lastMessageAt: at(17, 39) },
        { sessionId: 19216, responsibleId: 7, completed: false, lastMessageAt: at(17, 29) },
        { sessionId: 19282, responsibleId: 7, completed: true, lastMessageAt: at(16, 24) },
        { sessionId: 19999, responsibleId: 7, completed: false, lastMessageAt: at(16, 0) },
      ],
      dialogs: {
        s19248: { id: 50512, role: 'member' },
        s19286: { id: 50572, role: 'member' },
        s19216: { id: 50462, role: 'member' },
        s19282: { id: 50564, role: 'guest' },
        // s19999 — нет доступа у пользователя
      },
      messages: {
        // у 19286 и 19216 последним идёт системное сообщение 17:57 — оно порядок не меняет
        c50572: {
          messages: [
            { id: 9, author_id: 0, date: '2026-10-21T17:57:33+03:00' },
            { id: 8, author_id: 50, date: '2026-10-21T17:39:02+03:00' },
          ],
          users: [client],
        },
        c50462: {
          messages: [
            { id: 7, author_id: 0, date: '2026-10-21T17:57:32+03:00' },
            { id: 6, author_id: 50, date: '2026-10-21T17:29:29+03:00' },
          ],
          users: [client],
        },
        c50512: { messages: [{ id: 5, author_id: 50, date: '2026-10-21T18:05:48+03:00' }], users: [client] },
        c50564: { messages: [{ id: 4, author_id: 7, date: '2026-10-21T16:24:00+03:00' }], users: [client, op] },
      },
    });
    const res = await svc.list(user, { scope: 'all' });
    expect(index.page).toHaveBeenCalledWith('p1', null, 0, 50);
    expect(call).not.toHaveBeenCalledWith('crm.activity.list', expect.anything());
    expect(res.exactOrder).toBe(true);
    expect(res.items.map((c) => c.sessionId)).toEqual([19248, 19286, 19216, 19282]);
    expect(res.items[1]).toMatchObject({
      waitingReply: true,
      lastMessage: { author: 'client', date: '2026-10-21T14:39:02.000Z' },
    });
    expect(res.nextOffset).toBeNull();
  });
});

describe('ChatsService phone search', () => {
  it('normalizes Russian numbers into CRM search variants', async () => {
    const { phoneVariants } = await import('./chats.service.js');
    expect(phoneVariants('8 (985) 123-45-67')).toEqual(['+79851234567', '89851234567', '79851234567']);
    expect(phoneVariants('+7 985 123 45 67')).toEqual(['+79851234567', '89851234567', '79851234567']);
    expect(phoneVariants('9851234567')).toEqual(['+79851234567', '89851234567', '79851234567']);
    expect(phoneVariants('12345')).toEqual([]);
  });

  it('finds CRM items by phone, then their open-line chats, with phones in summaries', async () => {
    const call = vi.fn(async (method: string) => {
      if (method === 'crm.duplicate.findbycomm') return { result: { CONTACT: [140], LEAD: [5] } };
      if (method === 'im.recent.list') return { result: { items: [] } };
      throw new Error(method);
    });
    const batch = vi.fn(async (cmds: Record<string, { method: string; params: Record<string, unknown> }>) => {
      const keys = Object.keys(cmds);
      if (keys[0] === 'CONTACT140')
        return { result: { CONTACT140: [{ CHAT_ID: '50580' }], LEAD5: [{ CHAT_ID: '50580' }, { CHAT_ID: '61' }] }, errors: {} };
      if (cmds[keys[0]].method === 'imopenlines.dialog.get')
        return {
          result: Object.fromEntries(
            keys.map((k) => [k, { id: Number(cmds[k].params.CHAT_ID), name: 'Клиент', role: 'guest', entity_id: 'wz_telegram|1|x|50', entity_data_2: 'LEAD|0|COMPANY|0|CONTACT|140|DEAL|0' }]),
          ),
          errors: {},
        };
      if (keys.includes('contact')) return { result: { contact: [{ ID: '140', PHONE: [{ VALUE: '+79851234567' }] }] }, errors: {} };
      return { result: {}, errors: {} };
    });
    const index = {
      byChat: vi.fn(async () => new Map([[50580, { sessionId: 19292, responsibleId: 236, completed: false, lastMessageAt: new Date('2026-10-21T18:29:43Z') }]])),
    } as unknown as OpenlineIndexService;
    const user = { portal: { id: 'p1' }, userId: 7, client: { call, batch, listAll: vi.fn() } } as unknown as B24UserContext;
    const res = await new ChatsService({} as FilesService, index).searchByPhone(user, { q: '8 985 123-45-67' });
    expect(call).toHaveBeenCalledWith('crm.duplicate.findbycomm', { type: 'PHONE', values: ['+79851234567', '89851234567', '79851234567'] });
    expect(res.items.map((c) => [c.chatId, c.sessionId, c.joined, c.phones])).toEqual([
      [50580, 19292, false, ['+79851234567']],
      [61, 0, false, ['+79851234567']],
    ]);
    await expect(new ChatsService({} as FilesService, index).searchByPhone(user, { q: '123' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('ChatsService: кэш списка чатов', () => {
  const indexed = [
    { chatId: 101, sessionId: 11, responsibleId: 7, completed: false, lastMessageAt: new Date('2026-10-22T09:00:00Z') },
    { chatId: 102, sessionId: 12, responsibleId: 8, completed: false, lastMessageAt: new Date('2026-10-22T08:00:00Z') },
  ];
  const base = {
    indexed,
    dialogs: {
      c101: { id: 101, name: 'Анна', role: 'member', entity_id: 'wa|1|A|50', entity_data_2: 'CONTACT|140|DEAL|678' },
      c102: { id: 102, name: 'Олег', role: 'guest', entity_id: 'wa|1|B|51', entity_data_2: '' },
    },
    messages: {
      c101: { messages: [{ id: 5, author_id: 50, date: '2026-10-22T12:00:00+03:00', text: 'Есть баня?' }], users: [client] },
      c102: { messages: [{ id: 6, author_id: 50, date: '2026-10-22T11:00:00+03:00', text: '=== Исходящее сообщение, автор: Телефон ===\nДа' }], users: [client] },
    },
  };

  it('cold first open goes to Bitrix24 and fills the cache; the next open is served from the database', async () => {
    const t = setup(base);
    (t.index.isActive as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const first = await t.svc.list(t.user, { scope: 'all' });
    expect(t.batch).toHaveBeenCalled();
    expect(first.items.map((c) => c.chatId)).toEqual([101, 102]);
    expect(t.cache.chats.size).toBe(2);

    const warm = setup({ ...base, cache: t.cache });
    (warm.index.isActive as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const second = await warm.svc.list(warm.user, { scope: 'all' });
    expect(warm.batch).not.toHaveBeenCalled(); // ни диалогов, ни сообщений из Битрикс24
    expect(second.items).toEqual(first.items);
    expect(second.items[1]).toMatchObject({ waitingReply: false, joined: false, lastMessage: { author: 'employee', preview: 'Да' } });
  });

  it('one row per chat for everyone, access per employee: a colleague is checked by Bitrix24 with own token', async () => {
    const mine = setup(base);
    (mine.index.isActive as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    await mine.svc.list(mine.user, { scope: 'all' });
    // Коллеге Битрикс24 не показывает чат 102.
    const colleague = setup({ ...base, userId: 8, cache: mine.cache, dialogs: { c101: base.dialogs.c101 } });
    (colleague.index.isActive as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const r = await colleague.svc.list(colleague.user, { scope: 'all' });
    expect(colleague.batch).toHaveBeenCalled(); // своих доступов в кэше нет — живая проверка
    expect(r.items.map((c) => c.chatId)).toEqual([101]);
    expect(mine.cache.chats.size).toBe(2); // сводки не задвоились
    expect(mine.cache.access.get('8:102')).toMatchObject({ allowed: false });
    // Повторно — из кэша, и недоступный чат по-прежнему скрыт.
    const again = setup({ ...base, userId: 8, cache: mine.cache });
    (again.index.isActive as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    expect((await again.svc.list(again.user, { scope: 'all' })).items.map((c) => c.chatId)).toEqual([101]);
    expect(again.batch).not.toHaveBeenCalled();
  });
});

