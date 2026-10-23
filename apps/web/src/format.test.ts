import { describe, expect, it } from 'vitest';
import { fmtDuration, fmtWhen } from './format.js';

const tz = 'Europe/Moscow';
const now = new Date('2026-10-23T16:00:00Z'); // 19:00 МСК

describe('fmtWhen', () => {
  it('сегодня, вчера, раньше — датой', () => {
    expect(fmtWhen('2026-10-23T15:11:00Z', tz, now)).toBe('сегодня в 18:11');
    expect(fmtWhen('2026-10-22T15:15:00Z', tz, now)).toBe('вчера в 18:15');
    expect(fmtWhen('2026-10-21T15:15:00Z', tz, now)).toBe('21.10 18:15');
  });
});

describe('fmtDuration', () => {
  it('минуты и секунды, часы', () => {
    expect(fmtDuration(45)).toBe('0:45');
    expect(fmtDuration(725)).toBe('12:05');
    expect(fmtDuration(3750)).toBe('1:02:30');
  });
});
