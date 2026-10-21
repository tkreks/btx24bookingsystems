import { ChatsService } from './chats.service.js';
import type { FilesService } from './files.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { Bitrix24Error } from '../bitrix24/rest/errors.js';

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
  } = {},
) {
  const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'crm.activity.list') return { result: opts.activities ?? [], next: opts.next };
    if (method === 'im.message.add') return { result: 900 + Number(String(params?.MESSAGE).length) };
    if (method === 'im.v2.File.upload') return { result: { messageId: 800 } };
    throw new Error(method);
  });
  const batch = vi.fn(async (cmds: Record<string, { method: string }>) => ({
    result: Object.fromEntries(
      Object.keys(cmds).map((k) => [k, (k.startsWith('s') ? opts.dialogs : opts.messages)?.[k]]),
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
  return { svc: new ChatsService(files), user, call, batch, listAll, files };
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
    });
    // закрытая сессия не ждёт ответа, гость — не участник
    expect(res.items[0]).toMatchObject({ joined: false, sessionClosed: true, waitingReply: false });
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
  it('sends steps in order: text via im.message.add, files via im.v2.File.upload with the text on the first file', async () => {
    const { svc, user, call, files } = setup();
    const res = await svc.send(user, 101, {
      steps: [
        { text: 'Здравствуйте', fileIds: [] },
        { text: 'Прайс', fileIds: ['f1', 'f2'] },
      ],
    });
    expect(res).toEqual({ sent: 2, messageIds: [912, 800, 800], error: null });
    const calls = call.mock.calls.map((c) => [c[0], c[1]]);
    expect(calls[0]).toEqual(['im.message.add', { DIALOG_ID: 'chat101', MESSAGE: 'Здравствуйте' }]);
    expect(calls[1]).toEqual([
      'im.v2.File.upload',
      { dialogId: 'chat101', fields: { FILE: { name: 'f1.jpg', content: 'eA==', message: 'Прайс' } } },
    ]);
    expect(calls[2][1]).toEqual({ dialogId: 'chat101', fields: { FILE: { name: 'f2.jpg', content: 'eA==' } } });
    expect(files.dropUnused).toHaveBeenCalledWith(user, ['f1', 'f2']);
  });

  it('stops at the first failing step and reports how far it got', async () => {
    const { svc, user, call } = setup();
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
