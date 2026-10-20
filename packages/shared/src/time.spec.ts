import { describe, expect, it } from 'vitest';
import { isIsoDate, todayIn, tzOffsetMinutes, zonedDayRange, zonedTimeToUtc } from './time.js';

describe('time helpers', () => {
  it('computes zone offsets', () => {
    expect(tzOffsetMinutes(new Date('2026-07-01T00:00:00Z'), 'Europe/Moscow')).toBe(180);
    expect(tzOffsetMinutes(new Date('2026-07-01T00:00:00Z'), 'Europe/Berlin')).toBe(120);
    expect(tzOffsetMinutes(new Date('2026-01-01T00:00:00Z'), 'Europe/Berlin')).toBe(60);
  });

  it('gives a Moscow day as [21:00Z previous day, 21:00Z)', () => {
    const { start, end } = zonedDayRange('2026-10-21', 'Europe/Moscow');
    expect(start.toISOString()).toBe('2026-10-20T21:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-21T21:00:00.000Z');
  });

  it('handles DST days (23h and 25h) correctly', () => {
    const spring = zonedDayRange('2026-03-29', 'Europe/Berlin');
    expect((spring.end.getTime() - spring.start.getTime()) / 3600_000).toBe(23);
    const autumn = zonedDayRange('2026-10-25', 'Europe/Berlin');
    expect((autumn.end.getTime() - autumn.start.getTime()) / 3600_000).toBe(25);
  });

  it('converts local time to UTC and crosses month boundaries', () => {
    expect(zonedTimeToUtc('2026-12-31', '23:30', 'Europe/Moscow').toISOString()).toBe('2026-12-31T20:30:00.000Z');
    expect(zonedDayRange('2026-12-31', 'Europe/Moscow').end.toISOString()).toBe('2026-12-31T21:00:00.000Z');
  });

  it('knows today in a zone and validates dates', () => {
    expect(todayIn('Europe/Moscow', new Date('2026-10-20T22:30:00Z'))).toBe('2026-10-21');
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('21.10.2026')).toBe(false);
  });
});
