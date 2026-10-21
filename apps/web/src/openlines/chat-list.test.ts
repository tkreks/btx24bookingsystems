import { describe, expect, it } from 'vitest';
import type { ChatSummary } from '@btx24/shared';
import { avatarTone, chatsCount, initials, isFullPhone, phoneDigits, visibleChats } from './chat-list.js';

const chat = (chatId: number, title: string, waitingReply: boolean, preview = '', connector = 'whatsapp'): ChatSummary => ({
  chatId,
  sessionId: chatId,
  title,
  connector,
  responsibleId: 1,
  lastMessage: { id: 1, date: '2026-10-21T10:00:00Z', author: 'client', preview, hasFiles: false },
  waitingReply,
  joined: true,
  sessionClosed: false,
  crm: { leadId: null, contactId: null, companyId: null, dealId: null },
  phones: chatId === 1 ? ['+7 (985) 123-45-67'] : [],
});

describe('chat list', () => {
  const items = [chat(1, 'Ольга', false, 'спасибо'), chat(2, 'Артём', true, 'Сколько стоит баня?', 'telegram'), chat(3, 'Борис', true)];

  it('filters by tab and searches title, channel and preview', () => {
    expect(visibleChats(items, 'waiting', '', 'recent').map((c) => c.chatId)).toEqual([2, 3]);
    expect(visibleChats(items, 'answered', '', 'recent').map((c) => c.chatId)).toEqual([1]);
    expect(visibleChats(items, 'all', 'БАНЯ', 'recent').map((c) => c.chatId)).toEqual([2]);
    expect(visibleChats(items, 'all', 'telegram', 'recent').map((c) => c.chatId)).toEqual([2]);
  });

  it('searches by any part of the client phone; full numbers go to the server', () => {
    expect(visibleChats(items, 'all', '985 123', 'recent').map((c) => c.chatId)).toEqual([1]);
    expect(visibleChats(items, 'all', '8 985 123-45-67', 'recent').map((c) => c.chatId)).toEqual([1]);
    expect(phoneDigits('+7 (985) 123-45-67')).toBe('9851234567');
    expect(isFullPhone('8 985 123-45-67')).toBe(true);
    expect(isFullPhone('985 12')).toBe(false);
    expect(isFullPhone('Иван 89851234567')).toBe(false);
  });

  it('keeps server order for «recent», sorts by name or waiting first', () => {
    expect(visibleChats(items, 'all', '', 'recent').map((c) => c.chatId)).toEqual([1, 2, 3]);
    expect(visibleChats(items, 'all', '', 'name').map((c) => c.chatId)).toEqual([2, 3, 1]);
    expect(visibleChats(items, 'all', '', 'waiting').map((c) => c.chatId)).toEqual([2, 3, 1]);
  });

  it('makes initials, stable tones and Russian plurals', () => {
    expect(initials('Артём')).toBe('А');
    expect(initials('максим тармосин')).toBe('МТ');
    expect(initials('+7 999')).toBe('79');
    expect(initials('—')).toBe('#');
    expect(avatarTone(18)).toBe(1);
    expect([1, 2, 5, 11, 22, 112].map(chatsCount)).toEqual(['1 чат', '2 чата', '5 чатов', '11 чатов', '22 чата', '112 чатов']);
  });
});
