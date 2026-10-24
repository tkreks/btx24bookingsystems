import type { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import type { FilesService } from './files.service.js';
import type { OpenlineIndexService } from './openline-index.service.js';
import { ChatsService } from './chats.service.js';
import { callClients, reachedInChat, type CallActivity } from './call-stats.js';
const since = new Date('2026-10-22T10:00:00Z');
function setup(portalId = 'p1') {
  const prisma = {
    openlineChatAccess: { findMany: vi.fn(async () => [{ chatId: 1 }]) },
    chatFolderItem: { findMany: vi.fn(async () => []) },
    openlineChat: { findMany: vi.fn(async () => [{ chatId: 1, crm: { contactId: 10 }, phones: ['+79000000000'], lastMessageAt: new Date('2026-10-22T12:00:00Z'), lastAuthor: 'client' }]) },
    systemMessage: { findMany: vi.fn(async () => [] as { chatId: number; messageId: number }[]) },
  };
  const client = { call: vi.fn(async () => ({ result: { messages: [{ id: 101, date: '2026-10-22T12:00:00Z', author_id: 9, text: 'Спасибо' }, { id: 100, date: '2026-10-22T11:00:00Z', author_id: 7, text: 'Отвечаем на вопрос' }], users: [{ id: 9, connector: true }, { id: 7, name: 'Анна' }] } })) };
  const user = { portal: { id: portalId, timezone: 'Europe/Moscow' }, userId: 7, client } as unknown as B24UserContext;
  const calls = [{ ID: '1', START_TIME: since.toISOString(), DIRECTION: '1', SETTINGS: { MISSED_CALL: true }, COMMUNICATIONS: [{ ENTITY_TYPE_ID: 3, ENTITY_ID: 10, VALUE: '+79000000000' }] }] as CallActivity[];
  return { svc: new ChatsService({} as FilesService, {} as OpenlineIndexService, prisma as unknown as PrismaService), prisma, user, client, clients: callClients(calls, since, new Date('2026-10-23'), null) };
}
describe('Диалог в чате снимает упущенный после пропущенного', () => {
  it.each(['p1', 'p2'])('сохраняет факт ответа, даже если последним написал клиент; портал %s', async (portalId) => {
    const t = setup(portalId), reached = await t.svc.reachedSince(t.user, since, t.clients);
    expect(reached).toHaveLength(1); expect(reachedInChat(t.clients[0], reached)).toBe(true);
    expect(reachedInChat(t.clients[0], [{ ...reached[0], at: since.getTime() - 1 }])).toBe(false);
    expect(t.prisma.openlineChatAccess.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { portalId, userId: 7, allowed: true } }));
    expect(t.prisma.systemMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ portalId }) }));
  });
  it('находит чат контакта правами нового сотрудника без прогретого кэша доступа', async () => {
    const t = setup(); t.prisma.openlineChatAccess.findMany.mockResolvedValue([]);
    const original = t.client.call.getMockImplementation()!;
    t.client.call.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === 'imopenlines.crm.chat.get') return { result: [{ CHAT_ID: '2' }] } as never;
      if (args[0] === 'imopenlines.dialog.get') return { result: { entity_data_2: 'CONTACT|10' } } as never;
      return original();
    });
    expect(reachedInChat(t.clients[0], await t.svc.reachedSince(t.user, since, t.clients))).toBe(true);
  });
  it('автоматическая рассылка не считается диалогом сотрудника', async () => {
    const t = setup(); t.prisma.systemMessage.findMany.mockResolvedValue([{ chatId: 1, messageId: 100 }]);
    expect(await t.svc.reachedSince(t.user, since, t.clients)).toEqual([]);
  });
  it('без подтверждённого доступа или при ошибке чтения диалог не выдумывается', async () => {
    const t = setup(); t.client.call.mockRejectedValue(new Error('denied'));
    expect(await t.svc.reachedSince(t.user, since, t.clients)).toEqual([]);
    t.prisma.openlineChatAccess.findMany.mockResolvedValue([]); t.client.call.mockClear();
    expect(await t.svc.reachedSince(t.user, since, t.clients)).toEqual([]); expect(t.client.call).not.toHaveBeenCalledWith('im.dialog.messages.get', expect.anything());
  });
});
