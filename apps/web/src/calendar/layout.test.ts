import { describe, expect, it } from 'vitest';
import type { CalendarBooking } from '@btx24/shared';
import { availabilityPieces, layoutResourceDay } from './layout.js';

const day0 = Date.parse('2026-10-20T21:00:00Z'); // 00:00 МСК
const day1 = day0 + 86_400_000;
const b = (id: number, start: string, end: string, resourceIds = [1]): CalendarBooking => ({
  id,
  name: `B${id}`,
  description: null,
  resourceIds,
  start,
  end,
  dealId: null,
  deal: null,
  fields: [],
});

describe('layoutResourceDay', () => {
  it('places a booking in minutes from the start of the day', () => {
    const [p] = layoutResourceDay([b(1, '2026-10-21T07:00:00Z', '2026-10-21T09:30:00Z')], 1, day0, day1);
    expect(p).toMatchObject({ top: 600, height: 150, lane: 0, lanes: 1 });
  });

  it('clips bookings that cross midnight and flags continuation', () => {
    const [p] = layoutResourceDay([b(1, '2026-10-20T18:00:00Z', '2026-10-21T02:00:00Z')], 1, day0, day1);
    expect(p).toMatchObject({ top: 0, height: 300, continuesBefore: true, continuesAfter: false });
  });

  it('treats back-to-back bookings as non-overlapping ([start, end))', () => {
    const placed = layoutResourceDay(
      [b(1, '2026-10-21T06:00:00Z', '2026-10-21T09:00:00Z'), b(2, '2026-10-21T09:00:00Z', '2026-10-21T10:00:00Z')],
      1,
      day0,
      day1,
    );
    expect(placed.map((p) => [p.lane, p.lanes])).toEqual([
      [0, 1],
      [0, 1],
    ]);
  });

  it('puts overlapping bookings into separate lanes and ignores other resources', () => {
    const placed = layoutResourceDay(
      [
        b(1, '2026-10-21T06:00:00Z', '2026-10-21T09:00:00Z'),
        b(2, '2026-10-21T07:00:00Z', '2026-10-21T08:00:00Z'),
        b(3, '2026-10-21T07:00:00Z', '2026-10-21T08:00:00Z', [2]),
      ],
      1,
      day0,
      day1,
    );
    expect(placed.map((p) => [p.booking.id, p.lane, p.lanes])).toEqual([
      [1, 0, 2],
      [2, 1, 2],
    ]);
  });
});

describe('availabilityPieces', () => {
  it('splits the day into free / booked / tech with booked winning over tech', () => {
    const bookings = [
      b(1, '2026-10-21T07:00:00Z', '2026-10-21T09:00:00Z'),
      b(2, '2026-10-21T09:30:00Z', '2026-10-21T10:00:00Z'),
    ];
    const tech = [{ resourceId: 1, bookingId: 1, start: '2026-10-21T09:00:00Z', end: '2026-10-21T10:00:00Z' }];
    const pieces = availabilityPieces(bookings, tech, 1, day0, day1);
    expect(pieces.map((p) => [p.kind, p.bookingId])).toEqual([
      ['free', null],
      ['booked', 1],
      ['tech', 1],
      ['booked', 2],
      ['free', null],
    ]);
    expect(pieces[0].from).toBe(0);
    expect(pieces[pieces.length - 1].to).toBe(1);
    expect(pieces[1].from).toBeCloseTo(10 / 24);
  });
  it('a resource without bookings is free all day', () => {
    expect(availabilityPieces([], [], 1, day0, day1)).toEqual([
      { kind: 'free', from: 0, to: 1, bookingId: null, start: null, end: null },
    ]);
  });
});
