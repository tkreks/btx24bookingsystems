import { describe, expect, it } from 'vitest';
import { messagePreview, timelineDateLabel } from './ClientTimeline.js';

describe('даты и краткие сообщения ленты клиента', () => {
  it('сегодня и вчера определяются по поясу портала, остальные даты — с годом', () => {
    const now = new Date('2026-10-23T22:30:00Z');
    expect(timelineDateLabel('2026-10-24', 'Europe/Moscow', now)).toBe('Сегодня');
    expect(timelineDateLabel('2026-10-23', 'Europe/Moscow', now)).toBe('Вчера');
    expect(timelineDateLabel('2026-10-22', 'Europe/Moscow', now)).toBe('22 октября 2026');
    expect(timelineDateLabel('2016-10-01', 'Europe/Moscow', now)).toBe('1 октября 2016');
  });
  it('предпросмотр — не больше 100 символов вместе с многоточием, включая emoji', () => {
    expect(messagePreview('  Здравствуйте!\nХочу   бронь  ')).toBe('Здравствуйте! Хочу бронь');
    expect(messagePreview('a'.repeat(100))).toHaveLength(100);
    expect(Array.from(messagePreview('📅'.repeat(120)))).toHaveLength(100);
    expect(messagePreview('a'.repeat(101)).endsWith('…')).toBe(true);
  });
});
