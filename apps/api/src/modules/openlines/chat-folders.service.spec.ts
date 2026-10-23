import { ChatFoldersService } from './chat-folders.service.js';
import type { ChatsService } from './chats.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';

const summary = (chatId: number, title: string, date: string, unread = 0) => ({
  chatId,
  title,
  unread,
  lastMessage: { id: 1, date, author: 'client', preview: `${title}: текст`, hasFiles: false },
});

function setup() {
  const folders = [{ id: 'f1', name: 'Внутренние', sort: 0, ignoreAttention: false, global: false, createdAt: new Date(), items: [{ chatId: 10 }, { chatId: 11 }] }];
  // Глобальная папка коллеги (8): чаты 20 (мне доступен) и 21 (нет).
  const global = [{ id: 'g1', name: 'Корпоративы', sort: 0, ignoreAttention: true, global: true, createdAt: new Date(), items: [{ chatId: 20 }, { chatId: 21 }] }];
  const prisma = {
    chatFolder: {
      findMany: vi.fn(async ({ where }: { where: { global?: boolean } }) => (where.global ? global : folders)),
      findFirst: vi.fn(async ({ where }: { where: { id: string; ownerUserId: number } }) => (where.id === 'f1' && where.ownerUserId === 7 ? folders[0] : null)),
      count: vi.fn(async () => 1),
      create: vi.fn(async ({ data }: { data: object }) => ({ id: 'f2', ...data })),
      delete: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
    },
    chatFolderItem: { upsert: vi.fn(async () => ({})), deleteMany: vi.fn(async () => ({ count: 1 })) },
    openlineChatAccess: { findMany: vi.fn(async () => [{ chatId: 20 }]) },
    chatFavorite: { upsert: vi.fn(async () => ({})), deleteMany: vi.fn(async () => ({ count: 1 })) },
  } as unknown as PrismaService;
  const chats = {
    favorites: vi.fn(async () => new Set([11])),
    myFolders: vi.fn(async () => new Map([[10, 'f1'], [11, 'f1'], [20, 'g1'], [21, 'g1']])),
    summariesByChat: vi.fn(async (_u: unknown, ids: number[]) =>
      [summary(10, 'Охрана', '2026-10-21T08:00:00Z', 2), summary(11, 'АХО', '2026-10-21T09:00:00Z', 5), summary(20, 'Свадьба', '2026-10-20T09:00:00Z', 1)].filter((c) =>
        ids.includes(c.chatId),
      ),
    ),
  } as unknown as ChatsService;
  const user = (userId = 7) => ({ portal: { id: 'p1' }, userId }) as unknown as B24UserContext;
  return { svc: new ChatFoldersService(prisma, chats), prisma, user };
}

describe('ChatFoldersService', () => {
  it('folder row: chat count, unread sum of its chats, latest message; ★ first; colleague global folder — only my accessible chats', async () => {
    const { svc, user } = setup();
    expect(await svc.list(user())).toEqual([
      expect.objectContaining({ id: 'favorites', kind: 'favorites', chatCount: 1, unread: 5 }),
      {
        id: 'f1',
        name: 'Внутренние',
        sort: 0,
        ignoreAttention: false,
        global: false,
        mine: true,
        kind: 'folder',
        chatCount: 2,
        unread: 7,
        last: { chatId: 11, title: 'АХО', preview: 'АХО: текст', date: '2026-10-21T09:00:00Z', author: 'client' },
      },
      expect.objectContaining({ id: 'g1', global: true, mine: false, ignoreAttention: true, chatCount: 1, unread: 1 }),
    ]);
  });

  it('only the owner can change a folder; put moves the chat (one folder per chat)', async () => {
    const { svc, prisma, user } = setup();
    await svc.put(user(), 'f1', 12);
    expect(prisma.chatFolderItem.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { portalId_ownerUserId_chatId: { portalId: 'p1', ownerUserId: 7, chatId: 12 } }, update: expect.objectContaining({ folderId: 'f1' }) }),
    );
    await expect(svc.put(user(8), 'f1', 12)).rejects.toMatchObject({ status: 404 });
    await expect(svc.rename(user(), 'f1', { name: '' })).rejects.toMatchObject({ status: 400 });
    await svc.takeOut(user(), 12);
    expect(prisma.chatFolderItem.deleteMany).toHaveBeenCalledWith({ where: { portalId: 'p1', ownerUserId: 7, chatId: 12 } });
  });
});
