import { expect, it } from 'vitest';
import { messageDay, messageLayers } from './AttentionMessage.js';
it.each([[0,1],[1,1],[2,2],[3,3],[4,4],[9,4],[100,4],[NaN,1],[-1,1]])('стопка %s: %s слоя, максимум четыре', (n,layers) => { expect(messageLayers(n)).toBe(layers); });
it('дата отдельно от времени, в поясе портала', () => {
  const now = new Date('2026-10-24T21:30:00Z');
  expect(messageDay('2026-10-24T21:01:00Z','Europe/Moscow',now)).toBe('сегодня');
  expect(messageDay('2026-10-24T20:59:00Z','Europe/Moscow',now)).toBe('вчера');
  expect(messageDay('2026-10-22T10:00:00Z','Europe/Moscow',now)).toBe('22.10.2026');
});
