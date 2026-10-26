import { describe, expect, it } from 'vitest';
import type { CalendarBooking, CalendarDay, ResourceStopDto } from '@btx24/shared';
import { resourceDayState, timelinePieces, withPast } from './timeline-data.js';

/** «Сейчас» до дней тестов: прошедшими они не считаются. */
const EARLY = Date.parse('2026-10-01T00:00:00Z');
const start = Date.parse('2026-10-24T21:00:00Z');
const end = Date.parse('2026-10-25T21:00:00Z');
const booking = (s: string, e: string): CalendarBooking => ({ id: 1, name: 'Бронь', resourceIds: [14], start: s, end: e, dealId: null, deal: null, fields: [], description: null });
const stop = (s = '2026-10-24T21:00:00Z', e = '2026-10-25T21:00:00Z'): ResourceStopDto => ({ id: 'stop14', resourceId: 14, from: '2026-10-25', to: '2026-10-25', start: s, end: e, reason: 'Ремонт', createdBy: 'Менеджер', createdAt: s });
const day = (bookings: CalendarBooking[] = [], stops: ResourceStopDto[] = []): CalendarDay => ({ date: '2026-10-25', timezone: 'Europe/Moscow', resources: [{ id: 14, name: 'Теремок' }], bookings, stops, techWindows: [] });

describe('стопы в шкале ресурсов', () => {
  it('Теремок на стопе весь день не имеет свободных участков; другой ресурс свободен', () => {
    const d = day([], [stop()]);
    expect(timelinePieces(d, 14, start, end)).toEqual([expect.objectContaining({ kind: 'stop', from: 0, to: 1, reason: 'Ремонт' })]);
    expect(timelinePieces(d, 15, start, end).map(p => p.kind)).toEqual(['free']);
  });
  it('частичный стоп разделяет свободное время; его границы полуоткрытые', () => {
    const d = day([], [stop('2026-10-25T07:00:00Z', '2026-10-25T09:00:00Z')]);
    expect(timelinePieces(d, 14, start, end).map(p => [p.kind, p.from, p.to])).toEqual([['free', 0, 10 / 24], ['stop', 10 / 24, 12 / 24], ['free', 12 / 24, 1]]);
    expect(timelinePieces(day([], [stop('2026-10-23T21:00:00Z', '2026-10-24T21:00:00Z')]), 14, start, end).map(p => p.kind)).toEqual(['free']);
  });
  it('бронь на стопе остаётся видимой, техокно стоп не отменяет', () => {
    const d = day([booking('2026-10-25T07:00:00Z', '2026-10-25T09:00:00Z')], [stop()]);
    d.techWindows = [{ resourceId: 14, bookingId: 1, start: '2026-10-25T09:00:00Z', end: '2026-10-25T10:00:00Z' }];
    const pieces = timelinePieces(d, 14, start, end);
    expect(pieces.filter(p => p.kind === 'booked')).toHaveLength(1);
    expect(pieces.some(p => p.kind === 'free' || p.kind === 'tech')).toBe(false);
  });
});
describe('период: день занят при любой брони', () => {
  it('учитывает даже одну минуту и завершившуюся утреннюю бронь', () => {
    expect(resourceDayState(day([booking('2026-10-25T00:00:00Z', '2026-10-25T00:01:00Z')]), 14, 'Europe/Moscow', EARLY).kind).toBe('booked');
  });
  it('не включает бронь, закончившуюся точно в полночь; учитывает переход через полночь', () => {
    expect(resourceDayState(day([booking('2026-10-24T19:00:00Z', '2026-10-24T21:00:00Z')]), 14, 'Europe/Moscow', EARLY).kind).toBe('free');
    expect(resourceDayState(day([booking('2026-10-24T20:59:00Z', '2026-10-24T21:01:00Z')]), 14, 'Europe/Moscow', EARLY).kind).toBe('booked');
  });
  it('стоп — отдельное закрытое состояние, а не свободный или занятый бронью день', () => {
    expect(resourceDayState(day([], [stop()]), 14, 'Europe/Moscow', EARLY).kind).toBe('stop');
    const both = resourceDayState(day([booking('2026-10-25T07:00:00Z', '2026-10-25T09:00:00Z')], [stop()]), 14, 'Europe/Moscow', EARLY);
    expect(both.kind).toBe('booked'); expect(both.stops).toHaveLength(1);
  });
});

describe('прошедшее время на шкале', () => {
  it('свободное, техокно и стоп до «сейчас» — серые, брони остаются; участок делится по «сейчас»', () => {
    const pieces = [
      { kind: 'free' as const, from: 0, to: 0.3, bookingId: null },
      { kind: 'booked' as const, from: 0.3, to: 0.4, bookingId: 1 },
      { kind: 'free' as const, from: 0.4, to: 1, bookingId: null },
    ];
    expect(withPast(pieces as never, 0, 100, 50).map((p) => [p.kind, p.from, p.to])).toEqual([['past', 0, 0.3], ['booked', 0.3, 0.4], ['past', 0.4, 0.5], ['free', 0.5, 1]]);
    expect(withPast(pieces as never, 0, 100, -1)).toEqual(pieces);
  });
  it('прошедший день без брони — «past», с бронью — «booked»', () => {
    const d = { date: '2026-10-24', resources: [], bookings: [], techWindows: [], stops: [] } as never;
    expect(resourceDayState(d, 14, 'Europe/Moscow', Date.parse('2026-10-26T00:00:00Z')).kind).toBe('past');
  });
});
