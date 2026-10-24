import type { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import type { FilesService } from './files.service.js';
import type { OpenlineIndexService } from './openline-index.service.js';
import { ChatsService, isWaiting } from './chats.service.js';

const mark = (noReplyMessageId: number | null) => ({ noReplyMessageId, noReplyByName: 'Анна', noReplyAt: new Date('2026-10-22T10:00:00Z') });

describe('«Не требует ответа» — общая отметка чата', () => {
  it('действует на отмеченном сообщении; новое сообщение клиента снова «ждёт ответа»', () => {
    expect(isWaiting(false, 'client', 100, null)).toBe(true);
    expect(isWaiting(false, 'client', 100, mark(100))).toBe(false);
    expect(isWaiting(false, 'client', 101, mark(100))).toBe(true);
    expect(isWaiting(false, 'operator', 100, null)).toBe(false);
    expect(isWaiting(true, 'client', 100, null)).toBe(false);
  });

  function setup(rows: Record<string, unknown>[], ignored: number[] = []) {
    const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...rows[0], ...data }));
    const prisma = {
      openlineChat: {
        findUnique: vi.fn(async () => rows[0] ?? null),
        update,
        findMany: vi.fn(async (args?: { where?: { chatId?: { in?: number[] } } }) => rows.filter((r) => !args?.where?.chatId?.in || args.where.chatId.in.includes(r.chatId as number))),
      },
      openlineChatAccess: { findMany: vi.fn(async () => rows.map((r) => ({ chatId: r.chatId }))) },
      chatFolderItem: { findMany: vi.fn(async () => ignored.map((chatId) => ({ chatId }))) },
      dashboardHiddenChat: { findMany: vi.fn(async () => []) },
    } as unknown as PrismaService;
    const call = vi.fn(async () => ({
      result: { items: [], messages: [{ id: 100, author_id: 55, date: '2026-10-22T09:00:00Z', text: 'Здравствуйте' }], users: [{ id: 55, connector: true }] },
    }));
    const user = { portal: { id: 'p1' }, userId: 7, userName: 'Анна', client: { call } } as unknown as B24UserContext;
    return { svc: new ChatsService({} as FilesService, {} as OpenlineIndexService, prisma), user, update };
  }
  const row = (o: Record<string, unknown>) => ({ id: 'c', chatId: 50580, completed: false, lastAuthor: 'client', lastMessageId: 100, noReplyMessageId: null, noReplyByName: null, noReplyAt: null, crm: { dealId: 678, contactId: 140 }, title: 'Иванов', connector: 'telegram', lastMessageAt: new Date(), checkedAt: new Date(), lastPreview: '', lastHasFiles: false, responsibleId: 7, ...o });

  it('сотрудник ставит «Не требует ответа» — на последнем сообщении, с автором', async () => {
    const t = setup([row({})]);
    const r = await t.svc.setReplyStatus(t.user, 50580, { needed: false });
    expect(t.update.mock.calls[0][0].data).toMatchObject({ noReplyMessageId: 100, noReplyByUserId: 7, noReplyByName: 'Анна' });
    expect(r).toMatchObject({ chatId: 50580, waitingReply: false, noReply: { byName: 'Анна' } });
    await expect(t.svc.setReplyStatus(t.user, 50580, { needed: 'да' })).rejects.toMatchObject({ status: 400 });
  });

  it('«требуют внимания»: только ждущие ответа доступные чаты, без отмеченных', async () => {
    const t = setup([row({}), row({ chatId: 2, noReplyMessageId: 100 }), row({ chatId: 3, lastMessageId: 200, noReplyMessageId: 150 })]);
    const a = await t.svc.attention(t.user);
    expect(a.waiting).toBe(2);
    expect(a.items.map((i) => [i.chatId, i.dealId])).toEqual([[50580, 678], [3, 678]]);
  });

  it('чаты моих папок «Не обращать внимания» — не требуют внимания', async () => {
    const t = setup([row({}), row({ chatId: 3 })], [3]);
    const a = await t.svc.attention(t.user);
    expect(a.items.map((i) => i.chatId)).toEqual([50580]);
  });

  it('каналы клиента: только положительно разрешённые чаты того же контакта', async () => {
    const rows = [row({}), row({ chatId: 2, connector: 'whatsapp' }), row({ chatId: 3, crm: { contactId: 999 } }), row({ chatId: 4, connector: 'vk' })];
    const prisma = {
      openlineChat: { findUnique: vi.fn(async () => ({ crm: { contactId: 140 } })), findMany: vi.fn(async () => rows) },
      openlineChatAccess: { findMany: vi.fn(async () => [{ chatId: 4 }]) },
      messengerMessage: { findFirst: vi.fn(async () => null) },
    } as unknown as PrismaService;
    const svc = new ChatsService({} as FilesService, {} as OpenlineIndexService, prisma);
    vi.spyOn(svc, 'summariesByChat').mockImplementation(async (_user, ids) => rows.filter(r => ids.includes(r.chatId) && r.chatId !== 4).map(r => ({ chatId: r.chatId, connector: r.connector, title: r.title, lastMessage: null, waitingReply: false }) as never));
    const r = await svc.channels({ portal: { id: 'p1' }, userId: 7 } as unknown as B24UserContext, 50580);
    expect(r.map((c) => [c.chatId, c.connector])).toEqual([[50580, 'telegram'], [2, 'whatsapp']]);
  });
});
