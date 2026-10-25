import { describe, expect, it } from 'vitest';
import { timelineDays, timelineHours } from './ResourceTimelineBlock.js';

describe('шкала броней: дни от сегодня до конца периода', () => {
  it('сегодня → конец периода, не больше недели', () => {
    expect(timelineDays('2026-10-25', '2026-10-25')).toEqual(['2026-10-25']);
    expect(timelineDays('2026-10-25', '2026-10-27')).toEqual(['2026-10-25', '2026-10-26', '2026-10-27']);
    expect(timelineDays('2026-10-25', '2026-11-30')).toHaveLength(7);
  });
  it('один выбранный день, включая прошлую дату', () => {
    expect(timelineDays('2026-10-24', '2026-10-24')).toEqual(['2026-10-24']);
  });
});


describe('часовые деления шкалы в поясе портала', () => {
  it('начинаются в ближайший полный местный час, а не через час после сейчас', () => {
    const start = Date.parse('2026-10-25T07:37:22Z');
    const ticks = timelineHours(start, Date.parse('2026-10-25T10:00:00Z'), 'Europe/Moscow');
    expect(ticks.map(t => t.time)).toEqual(['11:00', '12:00']);
    expect(ticks[0].key).toBe(Date.parse('2026-10-25T08:00:00Z'));
    expect(ticks.every(t => t.at > 0 && t.at < 1)).toBe(true);
  });
  it('учитывают смещение на 45 минут и смену местной даты', () => {
    const ticks = timelineHours(Date.parse('2026-10-25T17:30:00Z'), Date.parse('2026-10-25T19:30:00Z'), 'Asia/Kathmandu');
    expect(ticks.map(t => [t.time, t.midnight, t.date])).toEqual([['00:00', true, '2026-10-26'], ['01:00', false, '2026-10-26']]);
    expect(ticks[0].key).toBe(Date.parse('2026-10-25T18:15:00Z'));
  });
  it('сохраняют два разных деления повторного часа при переводе часов назад', () => {
    const ticks = timelineHours(Date.parse('2026-10-24T23:30:00Z'), Date.parse('2026-10-25T03:00:00Z'), 'Europe/Berlin');
    expect(ticks.map(t => t.time)).toEqual(['02:00', '02:00', '03:00']);
    expect(new Set(ticks.map(t => t.key)).size).toBe(3);
  });
  it('не добавляют делений вне пустого диапазона', () => {
    const at = Date.parse('2026-10-25T08:00:00Z');
    expect(timelineHours(at, at, 'UTC')).toEqual([]);
  });
});
