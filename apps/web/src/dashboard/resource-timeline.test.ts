import { describe, expect, it } from 'vitest';
import type { CalendarBooking, CalendarDay } from '@btx24/shared';
import { lastRangeDay, resourceMonthState, timelineDays, timelineHours, timelineMonths } from './ResourceTimelineBlock.js';

describe('шкала броней: дни от сегодня до конца периода', () => {
  it('сегодня → конец периода включительно', () => {
    expect(timelineDays('2026-10-25', '2026-10-25')).toEqual(['2026-10-25']);
    expect(timelineDays('2026-10-25', '2026-10-27')).toEqual(['2026-10-25', '2026-10-26', '2026-10-27']);
    expect(timelineDays('2026-10-25', '2026-11-30')).toHaveLength(37);
  });
  it('период — до 30 месяцев; длинный — по месяцам с неполными краями', () => {
    expect(lastRangeDay('2026-10-29')).toBe('2029-04-28');
    expect(timelineDays('2026-10-29', lastRangeDay('2026-10-29')).at(-1)).toBe('2029-04-28');
    expect(timelineMonths(timelineDays('2026-10-29', '2027-01-05'))).toEqual([
      { key: '2026-10', from: '2026-10-29', to: '2026-10-31' },
      { key: '2026-11', from: '2026-11-01', to: '2026-11-30' },
      { key: '2026-12', from: '2026-12-01', to: '2026-12-31' },
      { key: '2027-01', from: '2027-01-01', to: '2027-01-05' },
    ]);
  });
  it('ячейка месяца — брони ресурса в этом месяце', () => {
    const b = (id: number, start: string, end: string, resourceIds = [1]) => ({ id, start, end, resourceIds }) as CalendarBooking;
    const day = { bookings: [b(1, '2026-11-30T20:00:00Z', '2026-12-01T08:00:00Z'), b(2, '2026-12-10T10:00:00Z', '2026-12-10T12:00:00Z'), b(3, '2026-12-11T10:00:00Z', '2026-12-11T12:00:00Z', [2])] } as CalendarDay;
    const dec = { from: '2026-12-01', to: '2026-12-31' };
    expect(resourceMonthState(day, dec, 1, 'Europe/Moscow', Date.parse('2026-10-29T00:00:00Z')).bookings.map((x) => x.id)).toEqual([1, 2]);
    expect(resourceMonthState(day, { from: '2026-09-01', to: '2026-09-30' }, 1, 'Europe/Moscow', Date.parse('2026-10-29T00:00:00Z')).kind).toBe('past');
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
