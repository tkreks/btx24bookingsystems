import { describe, expect, it } from 'vitest';
import { liveBookingWhen, paidTone } from './LiveBookingsBlock.js';
import { liveBookings } from './ResourceTimelineBlock.js';

const tz = 'Europe/Moscow';
const now = new Date('2026-10-25T09:00:00Z'); // 12:00 МСК

describe('liveBookingWhen', () => {
  it('сегодня — только время начала, другой день — дата и время', () => {
    expect(liveBookingWhen({ start: '2026-10-25T12:00:00Z', end: '2026-10-25T14:00:00Z' }, 'upcoming', tz, now)).toBe('15:00');
    expect(liveBookingWhen({ start: '2026-10-26T12:00:00Z', end: '2026-10-26T14:00:00Z' }, 'upcoming', tz, now)).toMatch(/26\.10.*15:00/);
  });
  it('текущая — «до» окончания', () => {
    expect(liveBookingWhen({ start: '2026-10-25T08:00:00Z', end: '2026-10-25T10:00:00Z' }, 'current', tz, now)).toBe('до 13:00');
  });
});

describe('paidTone', () => {
  it('различает полную, частичную и отсутствующую оплату', () => {
    expect(paidTone({ amount: 1000, paid: 1000 })).toBe('full');
    expect(paidTone({ amount: 1000, paid: 300 })).toBe('part');
    expect(paidTone({ amount: 1000, paid: 0 })).toBe('none');
    expect(paidTone({ amount: 1000, paid: null })).toBeNull();
  });
});

describe('liveBookings', () => {
  it('берёт брони, идущие сейчас, с полуоткрытым концом', () => {
    const list = [
      { id: 1, start: '2026-10-25T08:00:00Z', end: '2026-10-25T09:00:00Z' },
      { id: 2, start: '2026-10-25T09:00:00Z', end: '2026-10-25T10:00:00Z' },
      { id: 3, start: '2026-10-25T10:00:00Z', end: '2026-10-25T11:00:00Z' },
    ];
    expect(liveBookings(list, now.getTime()).map((b) => b.id)).toEqual([2]);
  });
});
