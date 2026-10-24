import type { CallLogRowDto, ChatSummary } from '@btx24/shared';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import type { BatchCommand } from '../bitrix24/rest/rest-client.js';
import type { ChatsService } from './chats.service.js';
import { callClientLinks } from './call-client-links.js';

const row = (id: number, contactId = 10): CallLogRowDto => ({ activityId: id, at: '2026-10-20T10:00:00Z', durationSec: 60, direction: 'incoming', status: 'success', clientPhone: null, employee: null, contact: contactId ? { id: contactId, name: 'Иван' } : null, owner: { typeId: 2, id: 50, title: 'Старая сделка' } });
function setup() {
  const batch = vi.fn(async (commands: Record<string, BatchCommand>) => ({ result: Object.fromEntries(Object.keys(commands).map((key) => [key,
    key.startsWith('d') ? [{ ID: '200', DATE_CREATE: '2026-10-25T10:00:00Z' }, { ID: '50', DATE_CREATE: '2026-10-01T10:00:00Z' }] :
    key.startsWith('p') ? { CONTACT: [10] } : [{ CHAT_ID: '1' }, { CHAT_ID: '2' }, { CHAT_ID: '3' }],
  ])), errors: {} }));
  const listAll = vi.fn(async () => [{ ID: '50', CONTACT_ID: '10' }]);
  const summariesByChat = vi.fn(async () => [
    { chatId: 1, lastMessage: { date: '2026-10-24T10:00:00Z' } },
    { chatId: 2, clientAvatar: 'https://portal.test/client.jpg', lastMessage: { date: '2026-10-25T10:00:00Z' } },
    // Чат3 недоступен: сводка его не возвращает.
  ] as ChatSummary[]);
  const user = { portal: { id: 'p1' }, userId: 7, client: { batch, listAll } } as unknown as B24UserContext;
  return { user, batch, listAll, summariesByChat, chats: { summariesByChat } as unknown as ChatsService };
}
describe('call client shortcuts with user permissions', () => {
  it('newest created deal irrespective of call date, latest accessible chat, deduplicated contacts', async () => {
    const t = setup();
    const result = await callClientLinks(t.user, t.chats, [row(1), row(2)], true);
    expect(result[0].clientAvatar).toBe('https://portal.test/client.jpg');
    expect(result.map((r) => [r.latestDealId, r.latestChatId])).toEqual([[200, 2], [200, 2]]);
    expect(t.batch).toHaveBeenCalledWith(expect.objectContaining({ d10: { method: 'crm.deal.list', params: { filter: { CONTACT_ID: 10 }, order: { DATE_CREATE: 'DESC', ID: 'DESC' }, select: ['ID', 'DATE_CREATE'] } } }));
    expect(t.summariesByChat).toHaveBeenCalledWith(t.user, [1, 2, 3]);
  });
  it('without app chat permission does not query chats', async () => {
    const t = setup();
    expect((await callClientLinks(t.user, t.chats, [row(1)], false))[0].latestChatId).toBeNull();
    expect(t.summariesByChat).not.toHaveBeenCalled();
    expect(Object.values(t.batch.mock.calls[0][0]).every((c) => c.method === 'crm.deal.list')).toBe(true);
  });
  it('resolves a contact through the visible call deal when communications are empty', async () => {
    const t = setup();
    expect((await callClientLinks(t.user, t.chats, [row(1, 0)], true))[0].latestDealId).toBe(200);
    expect(t.listAll).toHaveBeenCalledWith('crm.deal.list', { filter: { '@ID': [50] }, select: ['ID', 'CONTACT_ID'] });
  });
  it('empty or denied results hide shortcuts without losing the call', async () => {
    const t = setup(); t.batch.mockRejectedValue(new Error('ACCESS_DENIED'));
    expect((await callClientLinks(t.user, t.chats, [row(1)], true))[0]).toMatchObject({ activityId: 1, latestDealId: null, latestChatId: null });
  });
  it('phone fallback finds contacts without confusing lead/deal IDs', async () => {
    const t = setup();
    const unknown = { ...row(1, 0), owner: { typeId: 1, id: 50, title: 'Лид' }, clientPhone: '+79990001122' };
    expect((await callClientLinks(t.user, t.chats, [unknown], false))[0].latestDealId).toBe(200);
    expect(t.listAll).not.toHaveBeenCalled();
    expect(t.batch.mock.calls[0][0].p1.method).toBe('crm.duplicate.findbycomm');
  });
});
