import type { PrismaService } from '../../prisma/prisma.service.js';
import { ConversationsService } from './conversations.service.js';

type Row = { chatId: number; connector: string; title: string; lineId: number; completed: boolean; lastMessageAt: Date; lastMessageId: number; msgFromId: number | null; msgToId: number | null; msgComplete: boolean; convKey: string };

/** База в памяти: чаты переписки, доступ сотрудника, хранимые сообщения. */
function setup(rows: Row[], access: { chatId: number; allowed: boolean }[]) {
  const messages = new Map<number, { chatId: number; messageId: number; dto: unknown; mid: string | null }>();
  const acc = new Map(access.map((a) => [a.chatId, { ...a, joined: true, checkedAt: new Date() }]));
  const byChat = (id: number) => rows.find((r) => r.chatId === id)!;
  const prisma = {
    openlineChat: {
      findUnique: vi.fn(async ({ where }: { where: { portalId_chatId: { chatId: number } } }) => byChat(where.portalId_chatId.chatId) ?? null),
      findMany: vi.fn(async ({ where }: { where: { convKey: string } }) => rows.filter((r) => r.convKey === where.convKey)),
      update: vi.fn(async ({ where, data }: { where: { portalId_chatId: { chatId: number } }; data: Partial<Row> }) => Object.assign(byChat(where.portalId_chatId.chatId), data)),
    },
    openlineChatAccess: {
      findMany: vi.fn(async () => [...acc.values()]),
      upsert: vi.fn(async () => undefined),
    },
    openlineMessage: {
      upsert: vi.fn(async ({ create }: { create: { chatId: number; messageId: number; dto: unknown; mid: string | null } }) => messages.set(create.messageId, create)),
      findMany: vi.fn(async ({ where, take }: { where: { chatId: number; messageId: { gte: number; lte: number; lt?: number } }; take: number }) =>
        [...messages.values()]
          .filter((m) => m.chatId === where.chatId && m.messageId >= where.messageId.gte && m.messageId <= where.messageId.lte && (where.messageId.lt === undefined || m.messageId < where.messageId.lt))
          .sort((a, b) => b.messageId - a.messageId)
          .slice(0, take)),
    },
    messenger: { findMany: vi.fn(async () => []) },
    messengerMessage: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  return { svc: new ConversationsService(prisma as unknown as PrismaService), prisma, messages };
}

const row = (chatId: number, over: Partial<Row> = {}): Row => ({
  chatId, connector: 'wz_whatsapp', title: `Чат ${chatId}`, lineId: 4, completed: true, lastMessageAt: new Date(chatId * 1000), lastMessageId: 0,
  msgFromId: null, msgToId: null, msgComplete: false, convKey: 'whatsapp:74993467272|c:140', ...over,
});
const im = (ids: number[]) => ({
  messages: ids.map((id) => ({ id, author_id: 5, date: new Date(id * 1000).toISOString(), text: `m${id}` })),
  users: [{ id: 5, name: 'Клиент', connector: true }],
});

describe('ConversationsService', () => {
  it('склеивает ленту двух чатов по ID сообщений и не показывает чат без доступа', async () => {
    const t = setup([row(4394), row(50848, { connector: 'btx24_whatsapp', lineId: 14 }), row(4396)], [{ chatId: 4394, allowed: true }, { chatId: 50848, allowed: true }, { chatId: 4396, allowed: false }]);
    const call = vi.fn(async (_m: string, p: { DIALOG_ID: string }) => ({ result: p.DIALOG_ID === 'chat4394' ? im([10, 30]) : im([20, 40]) }));
    const batch = vi.fn(async () => ({ result: { d4394: { id: 4394, role: 'member' } } }));
    const feed = await t.svc.feed({ portal: { id: 'p1' } as never, userId: 7, client: { call, batch } as never }, 4394, null, { store: true });
    expect(feed!.messages.map((m) => [m.id, m.chatId])).toEqual([[10, 4394], [20, 50848], [30, 4394], [40, 50848]]);
    expect(feed!.sendChatId).toBe(50848);
    expect(feed!.hidden).toBe(1);
    expect(t.messages.size).toBe(4);
  });

  it('хранимая история отдаётся из базы без запросов к порталу', async () => {
    const t = setup([row(1, { msgFromId: 10, msgToId: 30, msgComplete: true })], [{ chatId: 1, allowed: true }]);
    for (const id of [10, 20, 30]) t.messages.set(id, { chatId: 1, messageId: id, dto: { id, text: `m${id}` }, mid: null });
    const call = vi.fn();
    const batch = vi.fn(async () => ({ result: { d1: { id: 1, role: 'member' } } }));
    const feed = await t.svc.feed({ portal: { id: 'p1' } as never, userId: 7, client: { call, batch } as never }, 1, 25, { store: true });
    expect(feed!.messages.map((m) => m.id)).toEqual([10, 20]);
    expect(feed!.hasMore).toBe(false);
    expect(call).not.toHaveBeenCalled();
  });

  it('страница старше начала полной истории — из базы, пустая, без запросов', async () => {
    const t = setup([row(1, { msgFromId: 10, msgToId: 30, msgComplete: true })], [{ chatId: 1, allowed: true }]);
    const call = vi.fn();
    const feed = await t.svc.feed({ portal: { id: 'p1' } as never, userId: 7, client: { call, batch: vi.fn() } as never }, 1, 5, { store: true });
    expect(feed!.messages).toEqual([]);
    expect(feed!.hasMore).toBe(false);
    expect(call).not.toHaveBeenCalled();
  });

  it('нет доступа к открытому чату — 403', async () => {
    const t = setup([row(1)], [{ chatId: 1, allowed: false }]);
    const batch = vi.fn(async () => ({ result: {} }));
    await expect(t.svc.feed({ portal: { id: 'p1' } as never, userId: 7, client: { call: vi.fn(), batch } as never }, 1, null, { store: true })).rejects.toMatchObject({ status: 403 });
  });

  it('диапазон хранимой истории растёт только по примыкающим страницам', async () => {
    const t = setup([row(1, { msgFromId: 100, msgToId: 200 })], []);
    await t.svc.store('p1', 1, im([180, 220]), null, 2);
    expect(t.prisma.openlineChat.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: { msgFromId: 100, msgToId: 220, msgComplete: false } }));
    await t.svc.store('p1', 1, im([60, 90]), 100, 50);
    expect(t.prisma.openlineChat.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: { msgFromId: 60, msgToId: 220, msgComplete: true } }));
    // Разрыв: последние сообщения не перекрывают диапазон — диапазон начинается заново.
    await t.svc.store('p1', 1, im(Array.from({ length: 50 }, (_, i) => 1000 + i)), null, 50);
    expect(t.prisma.openlineChat.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: { msgFromId: 1000, msgToId: 1049, msgComplete: false } }));
  });
});

describe('ConversationsService.discover', () => {
  it('добавляет прежние чаты клиента в его переписку правами сотрудника, раз в 10 минут', async () => {
    const upsert = vi.fn(async () => undefined);
    const prisma = {
      openlineChat: {
        findUnique: vi.fn(async () => ({ crm: { leadId: null, contactId: 140, companyId: null, dealId: null } })),
        findMany: vi.fn(async () => [{ chatId: 4394 }]),
        upsert,
      },
      chatLineChannel: { findMany: vi.fn(async () => [{ lineId: 4, channel: 'whatsapp:74993467272' }]) },
    };
    const svc = new ConversationsService(prisma as unknown as PrismaService);
    const call = vi.fn(async () => ({ result: [{ CHAT_ID: '4394' }, { CHAT_ID: '1200' }] }));
    const batch = vi.fn(async () => ({ result: { c1200: { id: 1200, name: 'Старый чат', entity_id: 'wz_whatsapp_ceacd473beec8c39f54fd7afd810cd43d|4|ext|9', entity_data_2: 'LEAD|0|COMPANY|0|CONTACT|140|DEAL|7' } } }));
    const user = { portal: { id: 'p1' } as never, userId: 7, client: { call, batch } as never };
    expect(await svc.discover(user, 4394)).toBe(1);
    expect(call).toHaveBeenCalledWith('imopenlines.crm.chat.get', { CRM_ENTITY_TYPE: 'contact', CRM_ENTITY: 140, ACTIVE_ONLY: 'N' });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ chatId: 1200, lineId: 4, convKey: 'whatsapp:74993467272|c:140' }) }));
    expect(await svc.discover(user, 4394)).toBe(0);
    expect(call).toHaveBeenCalledTimes(1);
  });
});
