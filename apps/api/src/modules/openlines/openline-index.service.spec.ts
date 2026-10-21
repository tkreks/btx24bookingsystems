import { OpenlineIndexService } from './openline-index.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { Bitrix24RestClient } from '../bitrix24/rest/rest-client.js';
import type { Portal } from '../../generated/prisma/client.js';

const now = new Date('2026-10-21T15:10:00Z');

function setup(opts: { lastChecked?: Date | null; enabled?: boolean; fresh?: boolean } = {}) {
  const upserts: { chatId: number; data: Record<string, unknown> }[] = [];
  const prisma = {
    portalSettings: {
      findUnique: vi.fn(async () => (opts.enabled === undefined ? null : { dialogMetadataEnabled: opts.enabled })),
    },
    openlineChat: {
      findFirst: vi.fn(async () => (opts.fresh ? { id: 'x' } : null)),
      aggregate: vi.fn(async () => ({ _max: { checkedAt: opts.lastChecked ?? null } })),
      upsert: vi.fn(
        async ({
          where,
          update,
        }: {
          where: { portalId_chatId: { chatId: number } };
          update: Record<string, unknown>;
        }) => {
          upserts.push({ chatId: where.portalId_chatId.chatId, data: update });
        },
      ),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  } as unknown as PrismaService;
  const listAll = vi.fn(async (_m: string, p: { filter: { COMPLETED: string } }) =>
    p.filter.COMPLETED === 'N'
      ? [
          { ASSOCIATED_ENTITY_ID: '20', RESPONSIBLE_ID: '7', COMPLETED: 'N' },
          { ASSOCIATED_ENTITY_ID: '30', RESPONSIBLE_ID: '8', COMPLETED: 'N' },
        ]
      : [{ ASSOCIATED_ENTITY_ID: '10', RESPONSIBLE_ID: '7', COMPLETED: 'Y' }],
  );
  const dialogs: Record<string, unknown> = {
    s10: { id: 500, entity_id: 'wz_whatsapp_ceacd473beec8c39f54fd7afd810cd43d|1|a|1' },
    s20: { id: 500, entity_id: 'wz_whatsapp_ceacd473beec8c39f54fd7afd810cd43d|1|a|1' }, // тот же чат, новая сессия
    s30: { id: 600, entity_id: 'telegrambot|2|b|2' },
  };
  const messages: Record<string, unknown> = {
    c500: {
      messages: [
        { id: 3, author_id: 0, date: '2026-10-21T17:57:32+03:00' },
        { id: 2, author_id: 99, date: '2026-10-21T17:29:29+03:00' },
      ],
      users: [{ id: 99, connector: true }],
    },
    c600: { messages: [{ id: 5, author_id: 0, date: '2026-10-21T17:57:33+03:00' }], users: [] },
  };
  const batch = vi.fn(async (cmds: Record<string, unknown>) => ({
    result: Object.fromEntries(Object.keys(cmds).map((k) => [k, k.startsWith('s') ? dialogs[k] : messages[k]])),
  }));
  const client = { listAll, batch } as unknown as Bitrix24RestClient;
  return { svc: new OpenlineIndexService(prisma), prisma, client, listAll, upserts };
}

const portal = { id: 'p1' } as Portal;

describe('OpenlineIndexService.refresh', () => {
  it('indexes every open session plus recently closed ones, one row per chat with its latest session', async () => {
    const { svc, client, listAll, upserts, prisma } = setup();
    expect(await svc.refresh(portal, client, now)).toBe(2);
    // первый проход: закрытые за неделю
    expect(listAll.mock.calls[1][1]).toMatchObject({
      filter: { COMPLETED: 'Y', '>=LAST_UPDATED': '2026-10-14T15:10:00.000Z' },
    });
    const chat500 = upserts.find((u) => u.chatId === 500)!.data;
    expect(chat500).toMatchObject({
      sessionId: 20,
      completed: false,
      responsibleId: 7,
      connector: 'wz_whatsapp',
      lastAuthor: 'client',
    });
    expect((chat500.lastMessageAt as Date).toISOString()).toBe('2026-10-21T14:29:29.000Z');
    // только системные сообщения — прежнюю дату не трогаем
    expect(upserts.find((u) => u.chatId === 600)!.data).not.toHaveProperty('lastMessageAt');
    expect(prisma.openlineChat.updateMany).toHaveBeenCalledWith({
      where: { portalId: 'p1', completed: false, checkedAt: { lt: now } },
      data: { completed: true },
    });
  });

  it('later passes look back from the previous pass with an overlap', async () => {
    const { svc, client, listAll } = setup({ lastChecked: new Date('2026-10-21T15:09:00Z') });
    await svc.refresh(portal, client, now);
    expect(listAll.mock.calls[1][1]).toMatchObject({ filter: { '>=LAST_UPDATED': '2026-10-21T14:59:00.000Z' } });
  });
});

describe('OpenlineIndexService.isActive', () => {
  it('requires the metadata switch and a fresh index', async () => {
    expect(await setup({ enabled: false, fresh: true }).svc.isActive('p1', now)).toBe(false);
    expect(await setup({ enabled: true, fresh: false }).svc.isActive('p1', now)).toBe(false);
    expect(await setup({ enabled: true, fresh: true }).svc.isActive('p1', now)).toBe(true);
  });
});
