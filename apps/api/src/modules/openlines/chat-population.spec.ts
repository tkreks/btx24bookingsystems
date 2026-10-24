import type { ChatSummary } from '@btx24/shared';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import type { FilesService } from './files.service.js';
import type { OpenlineIndexService } from './openline-index.service.js';
import { ChatsService } from './chats.service.js';

function setup(portalId = 'p1') {
  const rows = Array.from({ length: 62 }, (_, i) => ({ chatId: i + 1, completed: i === 60, lastAuthor: i === 61 ? 'operator' : 'client', lastMessageId: i + 100, noReplyMessageId: null, noReplyByName: null, noReplyAt: null, responsibleId: i % 2 ? 7 : 8, lastMessageAt: new Date('2026-10-24T10:00:00Z'), checkedAt: new Date(), crm: null }));
  const prisma = {
    openlineChatAccess: { findMany: vi.fn(async () => rows.map((r) => ({ chatId: r.chatId }))) },
    openlineChat: { findMany: vi.fn(async () => rows) },
    chatFolderItem: { findMany: vi.fn(async (q: { where: { folder?: { ignoreAttention?: boolean }; ownerUserId?: unknown } }) => q.where.folder?.ignoreAttention ? [{ chatId: 60 }] : typeof q.where.ownerUserId === 'number' ? rows.slice(0, 30).map((r) => ({ chatId: r.chatId, folderId: 'ordinary' })) : []) },
    dashboardHiddenChat: { findMany: vi.fn(async () => [{ chatId: 1 }]) },
    bookingRecord: { findMany: vi.fn(async () => [] as { dealId: number | null }[]) },
    paymentRequest: { findMany: vi.fn(async () => [] as { dealId: number }[]) },
    crmDeal: { findMany: vi.fn(async () => [] as { contactId: number | null }[]) },
  };
  const svc = new ChatsService({} as FilesService, {} as OpenlineIndexService, prisma as unknown as PrismaService);
  const realList = svc.list.bind(svc);
  vi.spyOn(svc, 'list').mockImplementation((u, q) => (q as { status?: string }).status ? realList(u, q) : Promise.resolve({ items: [], nextOffset: null, exactOrder: true }));
  vi.spyOn(svc, 'summariesByChat').mockImplementation(async (_, ids) => ids.map((chatId) => ({ chatId, waitingReply: true } as ChatSummary)));
  const user = { portal: { id: portalId, timezone: 'Europe/Moscow' }, userId: 7, client: { call: vi.fn(async () => ({ result: { items: [] } })) } } as unknown as B24UserContext;
  return { svc, user, prisma };
}

describe('Общая выборка чатов и дашборда', () => {
  it('считает все страницы и обычные папки; скрытие строки не меняет число ожиданий', async () => {
    const t = setup();
    const first = await t.svc.list(t.user, { status: 'waiting' });
    const second = await t.svc.list(t.user, { status: 'waiting', offset: first.nextOffset });
    const attention = await t.svc.attention(t.user);
    expect(first.counts).toEqual({ all: 62, waiting: 59, mine: 31, booked: 0, payment: 0 });
    expect(first.items).toHaveLength(50);
    expect(second.items).toHaveLength(9);
    expect(second.nextOffset).toBeNull();
    expect(attention.waiting).toBe(59);
    expect(attention.items.some((r) => r.chatId === 1)).toBe(false);
    expect(first.items.some((r) => r.chatId === 1)).toBe(true);
    expect([...first.items, ...second.items].some((r) => r.chatId === 60)).toBe(false);
  });
  it.each(['p1', 'p2'])('одинаковый период и права сотрудника в портале %s', async (portalId) => {
    const t = setup(portalId);
    const period = { from: '2026-10-24', to: '2026-10-24' };
    await t.svc.list(t.user, { status: 'waiting', ...period });
    await t.svc.attention(t.user, 50, period);
    expect(t.prisma.openlineChatAccess.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { portalId, userId: 7, allowed: true } }));
    for (const [q] of t.prisma.openlineChat.findMany.mock.calls as unknown as [{ where: unknown }][]) expect(q.where).toEqual({ portalId, chatId: { in: expect.any(Array) }, lastMessageAt: { gte: new Date('2026-10-23T21:00:00Z'), lt: new Date('2026-10-24T21:00:00Z') } });
  });
  it('Мои фильтрует ответственного до пагинации, включая папки', async () => {
    const t = setup();
    const result = await t.svc.list(t.user, { status: 'all', scope: 'mine' });
    expect(result.items).toHaveLength(31);
    expect(result.items.every((r) => r.chatId % 2 === 0)).toBe(true);
  });
  it('дашборд отдаёт личные непрочитанные только у доступных/не скрытых чатов', async () => {
    const t = setup();
    vi.spyOn(t.svc, 'unreadByChat').mockResolvedValue(new Map([[1,8],[2,4],[3,12],[999,99]]));
    const result = await t.svc.attention(t.user);
    expect(result.items.find(r => r.chatId === 1)).toBeUndefined();
    expect(result.items.find(r => r.chatId === 2)?.unread).toBe(4);
    expect(result.items.find(r => r.chatId === 3)?.unread).toBe(12);
    expect(result.items.find(r => r.chatId === 4)?.unread).toBe(0);
    expect(result.items.find(r => r.chatId === 999)).toBeUndefined();
    expect(t.svc.unreadByChat).toHaveBeenCalledWith(t.user);
  });
  it('канал фильтрует популяцию до количества и пагинации, провайдеры одного транспорта объединены', async()=>{
    const t=setup();
    const original=t.prisma.openlineChat.findMany;
    const base=await original();
    original.mockResolvedValue(base.map((r,i)=>({...r,connector:i%2?'btx24_whatsapp':'telegrambot'})) as never);
    const r=await t.svc.list(t.user,{status:'all',channel:'whatsapp'});
    expect(r.counts?.all).toBe(31);expect(r.nextOffset).toBeNull();expect(r.channels).toEqual(['telegram','whatsapp']);
    expect(r.items.every(c=>c.chatId%2===0)).toBe(true);
  });
  it('дочитывает вторую страницу личных непрочитанных', async () => {
    const t = setup();
    vi.mocked(t.user.client.call).mockResolvedValueOnce({ result: { items: [{ id: 'chat1', counter: 2 }], hasMore: true } } as never).mockResolvedValueOnce({ result: { items: [{ chat_id: 222, counter: 9 }], hasMore: false } } as never);
    expect(await t.svc.unreadByChat(t.user)).toEqual(new Map([[1, 2], [222, 9]]));
    expect(t.user.client.call).toHaveBeenLastCalledWith('im.recent.list', { UNREAD_ONLY: 'Y', SKIP_OPENLINES: 'N', LIMIT: 200, OFFSET: 200 });
  });
  it('бронь сегодня и ждём оплату: сделка чата или контакт клиента этих сделок, до пагинации', async () => {
    const t = setup();
    const base = await t.prisma.openlineChat.findMany();
    t.prisma.openlineChat.findMany.mockResolvedValue(base.map((r) => ({ ...r, crm: r.chatId === 5 ? { dealId: 500 } : r.chatId === 6 ? { contactId: 66 } : r.chatId === 7 ? { dealId: 700 } : null })) as never);
    t.prisma.bookingRecord.findMany.mockResolvedValue([{ dealId: 500 }, { dealId: 501 }]);
    t.prisma.crmDeal.findMany.mockImplementation(async (q?: unknown) => ((q as { where: { dealId: { in: number[] } } }).where.dealId.in.includes(501) ? [{ contactId: 66 }] : []));
    t.prisma.paymentRequest.findMany.mockResolvedValue([{ dealId: 700 }]);
    const booked = await t.svc.list(t.user, { status: 'booked' });
    expect(booked.items.map((c) => c.chatId).sort()).toEqual([5, 6]);
    expect(booked.counts).toMatchObject({ booked: 2, payment: 1 });
    const payment = await t.svc.list(t.user, { status: 'payment' });
    expect(payment.items.map((c) => c.chatId)).toEqual([7]);
    // День брони — сегодня в часовом поясе портала; только активные брони этого портала со сделкой.
    expect(t.prisma.bookingRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ portalId: 'p1', status: 'active', dealId: { not: null } }) }));
    expect(t.prisma.paymentRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { portalId: 'p1', status: { in: ['link_pending', 'sent'] }, closedAt: null } }));
  });
});
