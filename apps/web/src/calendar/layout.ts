import type { CalendarBooking, CalendarTechWindow } from '@btx24/shared';

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
export function layoutResourceDay(
  bookings: CalendarBooking[],
  resourceId: number,
  dayStartMs: number,
  dayEndMs: number,
): PlacedBooking[] {
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
    return {
      booking: x.b,
      top,
      height: Math.max(bottom - top, 1),
      lane,
      lanes: 1,
      continuesBefore: x.s < dayStartMs,
      continuesAfter: x.e > dayEndMs,
      s: x.s,
      e: x.e,
    };
  });
  // Число дорожек — максимум одновременных броней в группе пересекающихся.
  for (const p of placed) {
    p.lanes = Math.max(...placed.filter((q) => q.s < p.e && q.e > p.s).map((q) => q.lane)) + 1;
  }
  return placed.map(({ s: _s, e: _e, ...p }) => p);
}

export type AvailabilityKind = 'free' | 'booked' | 'tech';
export interface AvailabilityPiece {
  kind: AvailabilityKind;
  /** Доля дня, 0…1. */
  from: number;
  to: number;
  /** Бронь (для «booked») или бронь, после которой тех. окно. */
  bookingId: number | null;
  /** Реальные границы брони/окна (могут выходить за день). */
  start: string | null;
  end: string | null;
}

/**
 * Шкала дня ресурса для карточки доступности: свободно / бронь / тех. окно. Бронь важнее
 * тех. окна; соседние куски одного вида и одного источника склеиваются.
 */
export function availabilityPieces(
  bookings: CalendarBooking[],
  techWindows: CalendarTechWindow[],
  resourceId: number,
  dayStartMs: number,
  dayEndMs: number,
): AvailabilityPiece[] {
  type Src = { kind: 'booked' | 'tech'; s: number; e: number; bookingId: number; start: string; end: string };
  const sources: Src[] = [
    ...bookings
      .filter((b) => b.resourceIds.includes(resourceId))
      .map((b) => ({
        kind: 'booked' as const,
        s: Date.parse(b.start),
        e: Date.parse(b.end),
        bookingId: b.id,
        start: b.start,
        end: b.end,
      })),
    ...techWindows
      .filter((t) => t.resourceId === resourceId)
      .map((t) => ({
        kind: 'tech' as const,
        s: Date.parse(t.start),
        e: Date.parse(t.end),
        bookingId: t.bookingId,
        start: t.start,
        end: t.end,
      })),
  ]
    .map((x) => ({ ...x, s: Math.max(x.s, dayStartMs), e: Math.min(x.e, dayEndMs) }))
    .filter((x) => x.e > x.s);
  const points = [...new Set([dayStartMs, dayEndMs, ...sources.flatMap((x) => [x.s, x.e])])].sort((a, b) => a - b);
  const span = dayEndMs - dayStartMs;
  const pieces: AvailabilityPiece[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const active = sources.filter((x) => x.s < b && x.e > a);
    const src = active.find((x) => x.kind === 'booked') ?? active.find((x) => x.kind === 'tech') ?? null;
    const kind: AvailabilityKind = src?.kind ?? 'free';
    const prev = pieces[pieces.length - 1];
    if (prev && prev.kind === kind && prev.bookingId === (src?.bookingId ?? null)) {
      prev.to = (b - dayStartMs) / span;
      continue;
    }
    pieces.push({
      kind,
      from: (a - dayStartMs) / span,
      to: (b - dayStartMs) / span,
      bookingId: src?.bookingId ?? null,
      start: src?.start ?? null,
      end: src?.end ?? null,
    });
  }
  return pieces;
}

/** Шаг выбора начала брони кликом по шкале дня. */
export const SLOT_MINUTES = 30;

/**
 * Начало новой брони по клику на шкале дня (минуты от начала дня): вниз до получаса, внутри
 * суток и не раньше `notBefore` (начало свободного куска, например конец тех. окна).
 */
export function slotAt(minute: number, dayMinutes: number, notBefore = 0): number {
  const snapped = Math.floor(Math.max(0, minute) / SLOT_MINUTES) * SLOT_MINUTES;
  return Math.max(Math.ceil(notBefore), Math.min(snapped, dayMinutes - SLOT_MINUTES));
}
