import { describe, expect, it } from 'vitest';
import { defaultPeriod, periodToUtc } from './booking-form.js';

const duration = { bookingMode: 'duration' as const, durationMinutes: 240, checkInTime: '14:00', checkOutTime: '12:00', defaultNights: 1 };

describe('booking form', () => {
  it('duration: from the clicked time for durationMinutes, across midnight', () => {
    expect(defaultPeriod(duration, '2026-10-23', '14:00')).toEqual({ startDate: '2026-10-23', startTime: '14:00', endDate: '2026-10-23', endTime: '18:00' });
    expect(defaultPeriod(duration, '2026-10-23', '22:30')).toEqual({ startDate: '2026-10-23', startTime: '22:30', endDate: '2026-10-24', endTime: '02:30' });
  });

  it('interval: check-in / check-out after default nights', () => {
    expect(defaultPeriod({ ...duration, bookingMode: 'interval', defaultNights: 2 }, '2026-10-31')).toEqual({ startDate: '2026-10-31', startTime: '14:00', endDate: '2026-11-02', endTime: '12:00' });
  });

  it('converts to UTC in the portal zone and rejects reversed periods', () => {
    expect(periodToUtc({ startDate: '2020-06-01', startTime: '14:00', endDate: '2020-06-01', endTime: '18:00' }, 'Europe/Moscow')).toEqual({ start: '2020-06-01T11:00:00.000Z', end: '2020-06-01T15:00:00.000Z' });
    expect(periodToUtc({ startDate: '2020-06-01', startTime: '14:00', endDate: '2020-06-01', endTime: '13:00' }, 'Europe/Moscow')).toEqual({ error: expect.any(String) });
  });
});
