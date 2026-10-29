import { appendServiceMessage, ServiceChatService } from './service-chat.service.js';

function setup(o: { chat?: boolean; deal?: boolean } = {}) {
  const messages: Record<string, unknown>[] = [];
  const db = {
    serviceChat: {
      findUnique: vi.fn(async () => (o.chat === false ? null : { id: 's1', createdAt: new Date('2026-10-29T10:00:00Z'), createdByUserId: 7 })),
      upsert: vi.fn(async () => ({})),
    },
    serviceChatMessage: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `m${messages.length}`, createdAt: new Date('2026-10-29T11:00:00Z'), authorName: null, ...data };
        messages.push(row);
        return row;
      }),
      findMany: vi.fn(async () => [...messages].reverse()),
    },
  };
  const call = vi.fn(async () => ({ result: o.deal === false ? null : { ID: '678' } }));
  const user = { portal: { id: 'p1' }, userId: 7, userName: 'Ира', client: { call } };
  return { db, user, call, messages, svc: new ServiceChatService(db as never) };
}

describe('Служебный чат сделки', () => {
  it('автоматика пишет только в существующий служебный чат', async () => {
    const t = setup();
    expect(await appendServiceMessage(t.db as never, 'p1', 678, 'payment', '  Ссылка: https://pay/x ')).toBe(true);
    expect(t.messages[0]).toMatchObject({ portalId: 'p1', dealId: 678, source: 'payment', text: 'Ссылка: https://pay/x' });
    const none = setup({ chat: false });
    expect(await appendServiceMessage(none.db as never, 'p1', 678, 'payment', 'x')).toBe(false);
    expect(none.db.serviceChatMessage.create).not.toHaveBeenCalled();
  });
  it('сотрудник видит и пишет, только если Битрикс24 открывает ему сделку; заметка — с автором', async () => {
    const t = setup();
    const m = await t.svc.post(t.user as never, 678, ' Позвонил, ссылку продиктовал ');
    expect(m).toMatchObject({ source: 'manager', text: 'Позвонил, ссылку продиктовал', authorName: 'Ира' });
    expect(t.call).toHaveBeenCalledWith('crm.deal.get', { id: 678 });
    expect((await t.svc.get(t.user as never, 678)).messages).toHaveLength(1);
    const hidden = setup({ deal: false });
    await expect(hidden.svc.get(hidden.user as never, 678)).rejects.toMatchObject({ status: 404 });
    await expect(t.svc.post(t.user as never, 678, '  ')).rejects.toMatchObject({ status: 400 });
  });
  it('создание повторяемо; без чата заметку не записать', async () => {
    const t = setup({ chat: false });
    await t.svc.create(t.user as never, 678);
    expect(t.db.serviceChat.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { portalId_dealId: { portalId: 'p1', dealId: 678 } }, update: {} }));
    await expect(t.svc.post(t.user as never, 678, 'x')).rejects.toMatchObject({ status: 404 });
  });
});
