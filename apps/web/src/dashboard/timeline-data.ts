import { zonedDayRange, type CalendarDay, type ResourceStopDto } from '@btx24/shared';
import { availabilityPieces, type AvailabilityPiece } from '../calendar/layout.js';

export type TimelinePiece = Omit<AvailabilityPiece, 'kind'> & { kind: AvailabilityPiece['kind'] | 'stop' | 'past'; reason?: string };

/** Стоп закрывает свободные участки и техокна; уже существующая бронь остаётся видимой. */
export function timelinePieces(day: Pick<CalendarDay, 'bookings' | 'techWindows' | 'stops'>, resourceId: number, start: number, end: number): TimelinePiece[] {
  const span = end - start;
  const stops = (day.stops ?? []).filter(s => s.resourceId === resourceId && Date.parse(s.start) < end && Date.parse(s.end) > start);
  return availabilityPieces(day.bookings, day.techWindows, resourceId, start, end).flatMap<TimelinePiece>(p => {
    if (p.kind === 'booked' || !stops.length) return [p];
    const inside = stops.filter(s => Date.parse(s.start) < start + p.to * span && Date.parse(s.end) > start + p.from * span);
    const points = [...new Set([p.from, p.to, ...inside.flatMap(s => [Math.max(p.from, (Date.parse(s.start) - start) / span), Math.min(p.to, (Date.parse(s.end) - start) / span)])])].sort((a, b) => a - b);
    return points.slice(0, -1).map((a, i): TimelinePiece => {
      const b = points[i + 1];
      const stop = inside.find(s => Date.parse(s.start) < start + b * span && Date.parse(s.end) > start + a * span);
      return stop ? { ...p, from: a, to: b, kind: 'stop', reason: stop.reason } : { ...p, from: a, to: b };
    });
  });
}

/**
 * Прошедшее время без брони — серым (решение владельца 2026-10-26): свободные участки, техокна и стопы до
 * `now` становятся «past» (бронь только на будущее); брони остаются как есть.
 */
export function withPast(pieces: TimelinePiece[], start: number, end: number, now: number): TimelinePiece[] {
  const at = (now - start) / (end - start);
  if (at <= 0) return pieces;
  return pieces.flatMap<TimelinePiece>(p => {
    if (p.kind === 'booked' || p.from >= at) return [p];
    if (p.to <= at) return [{ ...p, kind: 'past', reason: undefined }];
    return [{ ...p, to: at, kind: 'past', reason: undefined }, { ...p, from: at }];
  });
}

/**
 * Какая доля участка брони уже прошла (0..1) — прошедшую бронь шкала красит тёмно-красным
 * (решение владельца 2026-10-27), у идущей сейчас темнеет только прошедшая часть.
 */
export function pastShare(piece: Pick<TimelinePiece, 'from' | 'to'>, start: number, end: number, now: number): number {
  const at = (now - start) / (end - start);
  if (at <= piece.from) return 0;
  if (at >= piece.to) return 1;
  return (at - piece.from) / (piece.to - piece.from);
}

/** Ширина колонки названий ресурса на шкале (132px + отступ 8px) — от неё отсчитывается время. */
export const TIMELINE_LABEL_PX = 140;

/**
 * Прокрутка шкалы, когда она шире экрана (решение владельца 2026-10-27): по центру — текущее время
 * (`fraction` — его доля суток), в периоде — середина периода.
 */
export function centeredScrollLeft(gridWidth: number, clientWidth: number, fraction: number): number {
  const x = TIMELINE_LABEL_PX + fraction * (gridWidth - TIMELINE_LABEL_PX);
  return Math.max(0, Math.min(gridWidth - clientWidth, Math.round(x - clientWidth / 2)));
}

/** В периоде день занят при любом пересечении брони с местными сутками, включая прошлые часы; прошедший день без брони — «past». */
export function resourceDayState(day: CalendarDay, resourceId: number, timezone: string, now = Date.now()): { bookings: CalendarDay['bookings']; stops: ResourceStopDto[]; kind: 'booked' | 'stop' | 'free' | 'past' } {
  const { start, end } = zonedDayRange(day.date, timezone);
  const overlaps = (s: string, e: string) => Date.parse(s) < end.getTime() && Date.parse(e) > start.getTime();
  const bookings = day.bookings.filter(b => b.resourceIds.includes(resourceId) && overlaps(b.start, b.end));
  const stops = (day.stops ?? []).filter(s => s.resourceId === resourceId && overlaps(s.start, s.end));
  return { bookings, stops, kind: bookings.length ? 'booked' : end.getTime() <= now ? 'past' : stops.length ? 'stop' : 'free' };
}
