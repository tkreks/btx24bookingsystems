import type { CalendarBooking } from '@btx24/shared';

export interface PlacedBooking {
  booking: CalendarBooking;
  /** Минуты от начала дня (обрезано границами дня). */
  top: number;
  height: number;
  /** Дорожка при пересечении броней одного ресурса (в норме Битрикс24 их не допускает). */
  lane: number;
  lanes: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

/**
 * Раскладка броней ресурса по вертикальной шкале дня. Интервалы полуоткрытые [start, end):
 * бронь до 12:00 и бронь с 12:00 не пересекаются.
 */
export function layoutResourceDay(bookings: CalendarBooking[], resourceId: number, dayStartMs: number, dayEndMs: number): PlacedBooking[] {
  const minutes = (dayEndMs - dayStartMs) / 60_000;
  const items = bookings
    .filter((b) => b.resourceIds.includes(resourceId))
    .map((b) => ({ b, s: Date.parse(b.start), e: Date.parse(b.end) }))
    .filter((x) => x.e > dayStartMs && x.s < dayEndMs)
    .sort((a, c) => a.s - c.s || c.e - a.e);

  const laneEnds: number[] = [];
  const placed = items.map((x) => {
    let lane = laneEnds.findIndex((end) => end <= x.s);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = x.e;
    const top = Math.max(0, (x.s - dayStartMs) / 60_000);
    const bottom = Math.min(minutes, (x.e - dayStartMs) / 60_000);
    return { booking: x.b, top, height: Math.max(bottom - top, 1), lane, lanes: 1, continuesBefore: x.s < dayStartMs, continuesAfter: x.e > dayEndMs, s: x.s, e: x.e };
  });
  // Число дорожек — максимум одновременных броней в группе пересекающихся.
  for (const p of placed) {
    p.lanes = Math.max(...placed.filter((q) => q.s < p.e && q.e > p.s).map((q) => q.lane)) + 1;
  }
  return placed.map(({ s: _s, e: _e, ...p }) => p);
}
