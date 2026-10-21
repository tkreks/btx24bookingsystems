import { describe, expect, it } from 'vitest';
import { connectorLabel, fileSize, shortTime } from './format.js';

describe('openlines format', () => {
  it('names channels', () => {
    expect(connectorLabel('wz_whatsapp')).toBe('WhatsApp');
    expect(connectorLabel('telegrambot')).toBe('Telegram');
    expect(connectorLabel('livechat')).toBe('Онлайн-чат');
    expect(connectorLabel('custom_x')).toBe('custom_x');
  });
  it('shows time today and date otherwise, in the portal zone', () => {
    const now = new Date('2026-10-21T10:00:00Z');
    expect(shortTime('2026-10-21T08:05:00Z', 'Europe/Moscow', now)).toBe('11:05');
    expect(shortTime('2026-10-20T08:05:00Z', 'Europe/Moscow', now)).toBe('20.10');
    // 23:30 UTC 20.10 — это уже 21.10 по Москве
    expect(shortTime('2026-10-20T23:30:00Z', 'Europe/Moscow', now)).toBe('02:30');
  });
  it('formats sizes', () => {
    expect([fileSize(500), fileSize(2048), fileSize(3 * 1024 * 1024)]).toEqual(['500 Б', '2 КБ', '3.0 МБ']);
  });
});
