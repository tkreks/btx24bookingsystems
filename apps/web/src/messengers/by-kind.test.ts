import { describe, expect, it } from 'vitest';
import type { MessengerDto } from '@btx24/shared';
import { groupByKind, type SearchResult } from './by-kind.js';

const m = (id: string, kind: MessengerDto['kind']) => ({ id, kind, phone: '79000000000', title: id, state: 'ready', line: { mode: 'own' } }) as unknown as MessengerDto;
const r = (messenger: MessengerDto, status: SearchResult['status'], canSend = true) => ({ messenger, status, canSend, chatId: null, note: null, openlineChatId: null }) as SearchResult;

describe('поиск клиента по мессенджеру, а не по аккаунту', () => {
  const wa1 = m('wa1', 'whatsapp'), wa2 = m('wa2', 'whatsapp'), tg = m('tg', 'telegram');
  it('один значок на мессенджер; найден хотя бы в одном аккаунте — найден', () => {
    const rows = groupByKind([tg, wa1, wa2], [r(wa1, 'not_found'), r(wa2, 'found'), r(tg, 'not_found')]);
    expect(rows.map((x) => [x.kind, x.state, x.accounts.length, x.found.length])).toEqual([['whatsapp', 'found', 2, 1], ['telegram', 'not_found', 1, 0]]);
  });
  it('до ответа — проверяем; найден без права писать — «нет права»', () => {
    expect(groupByKind([wa1], null)[0].state).toBe('checking');
    expect(groupByKind([wa1], [r(wa1, 'found', false)])[0].state).toBe('denied');
  });
});
