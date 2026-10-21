import { ChatFoldersService } from './chat-folders.service.js';
import type { ChatsService } from './chats.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';

const summary = (chatId: number, title: string, date: string) => ({ chatId, title, lastMessage: { id: 1, date, author: 'client', preview: `${title}: текст`, hasFiles: false } });

function setup() {
  const folders = [{ id: 'f1', name: 'Внутренние', sort: 0, createdAt: new Date(), items: [{ chatId: 10 }, { chatId: 11 }] }];
  const prisma = {
    chatFolder: {
      findMany: vi.fn(async () => folders),
      findFirst: vi.fn(async ({ where }: { where: { id: string; ownerUserId: number } }) => (where.id === 'f1' && where.ownerUserId === 7 ? folders[0] : null)),
      count: vi.fn(async () => 1),
      create: vi.fn(async ({ data }: { data: object }) => ({ id: 'f2', ...data })),
      delete: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
    },
    chatFolderItem: { upsert: vi.fn(async () => ({})), deleteMany: vi.fn(async () => ({ count: 1 })) },
  } as unknown as PrismaService;
  const chats = {
    unreadByChat: vi.fn(async () => new Map([[10, 2], [11, 5], [99, 7]])),
    summariesByChat: vi.fn(async () => [summary(10, 'Охрана', '2026-10-21T08:00:00Z'), summary(11, 'АХО', '2026-10-21T09:00:00Z')]),
  } as unknown as ChatsService;
  const user = (userId = 7) => ({ portal: { id: 'p1' }, userId }) as unknown as B24UserContext;
  return { svc: new ChatFoldersService(prisma, chats), prisma, user };
}

describe('ChatFoldersService', () => {
  it('folder row: chat count, unread sum of its chats, latest message among them', async () => {
    const { svc, user } = setup();
    expect(await svc.list(user())).toEqual([
      { id: 'f1', name: 'Внутренние', sort: 0, chatCount: 2, unread: 7, last: { chatId: 11, title: 'АХО', preview: 'АХО: текст', date: '2026-10-21T09:00:00Z', author: 'client' } },
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
