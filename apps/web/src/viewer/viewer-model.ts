import { freeSpans, mergeSpans, zonedDayRange, type TimeSpan, type ViewerBookingDto, type ViewerDayDto } from '@btx24/shared';

export type ViewerMode = 'list' | 'calendar' | 'availability';
export const VIEWER_MODES: { id: ViewerMode; label: string }[] = [
  { id: 'list', label: 'Список' },
  { id: 'calendar', label: 'Календарь' },
  { id: 'availability', label: 'Доступность' },
];

export type TimeStatus = 'upcoming' | 'now' | 'done';
export const TIME_STATUS_LABELS: Record<TimeStatus, string> = { upcoming: 'Ожидание клиента', now: 'Идёт', done: 'Завершена' };

export function timeStatus(b: Pick<ViewerBookingDto, 'startsAt' | 'endsAt'>, now = Date.now()): TimeStatus {
  if (now < Date.parse(b.startsAt)) return 'upcoming';
  return now < Date.parse(b.endsAt) ? 'now' : 'done';
}

export const minutesOf = (b: Pick<ViewerBookingDto, 'startsAt' | 'endsAt'>) => Math.round((Date.parse(b.endsAt) - Date.parse(b.startsAt)) / 60_000);

export function resourceName(day: Pick<ViewerDayDto, 'resources'>, ids: number[]): string {
  return ids.map((id) => day.resources.find((r) => r.id === id)?.name ?? `Ресурс ${id}`).join(', ');
}

export type Piece = { kind: 'free' | 'busy' | 'tech'; start: number; end: number; booking?: ViewerBookingDto };

export interface ResourceAvailability {
  resourceId: number;
  name: string;
  from: number;
  to: number;
  bookings: ViewerBookingDto[];
  pieces: Piece[];
  free: TimeSpan[];
  busyMinutes: number;
  freeMinutes: number;
  load: number;
  longestFree: number;
  /** Свободно сейчас (только для сегодняшнего дня), иначе null. */
  freeNow: boolean | null;
}

/**
 * Доступность ресурса за день (сутки в поясе портала): занято — брони, тех. окна — предупреждение
 * (бронь они не запрещают), свободно — остальное.
 */
export function availability(day: ViewerDayDto, resourceId: number, now = Date.now()): ResourceAvailability {
  const { start, end } = zonedDayRange(day.date, day.timezone);
  const from = start.getTime();
  const to = end.getTime();
  const bookings = day.bookings.filter((b) => b.resourceIds.includes(resourceId));
  const busy = mergeSpans(bookings.map((b) => ({ start: Date.parse(b.startsAt), end: Date.parse(b.endsAt) })), from, to);
  const free = freeSpans(busy, from, to);
  const tech = mergeSpans(day.techWindows.filter((t) => t.resourceId === resourceId).map((t) => ({ start: Date.parse(t.startsAt), end: Date.parse(t.endsAt) })), from, to);
  const pieces: Piece[] = [];
  for (const f of free) {
    // Тех. окно внутри свободного времени — отдельным оранжевым отрезком.
    let at = f.start;
    for (const t of tech.filter((x) => x.end > f.start && x.start < f.end)) {
      const s = Math.max(t.start, f.start);
      const e = Math.min(t.end, f.end);
      if (s > at) pieces.push({ kind: 'free', start: at, end: s });
      pieces.push({ kind: 'tech', start: s, end: e });
      at = e;
    }
    if (at < f.end) pieces.push({ kind: 'free', start: at, end: f.end });
  }
  for (const b of bookings) {
    const s = Math.max(Date.parse(b.startsAt), from);
    const e = Math.min(Date.parse(b.endsAt), to);
    if (e > s) pieces.push({ kind: 'busy', start: s, end: e, booking: b });
  }
  pieces.sort((a, b) => a.start - b.start || (a.kind === 'busy' ? -1 : 1));
  const busyMinutes = busy.reduce((n, s) => n + (s.end - s.start) / 60_000, 0);
  const total = (to - from) / 60_000;
  return {
    resourceId,
    name: day.resources.find((r) => r.id === resourceId)?.name ?? `Ресурс ${resourceId}`,
    from,
    to,
    bookings,
    pieces,
    free,
    busyMinutes,
    freeMinutes: total - busyMinutes,
    load: total ? Math.round((busyMinutes / total) * 100) : 0,
    longestFree: Math.max(0, ...free.map((f) => (f.end - f.start) / 60_000)),
    freeNow: now >= from && now < to ? free.some((f) => f.start <= now && now < f.end) : null,
  };
}

/** Часы сетки календаря: по умолчанию 08–22, шире — если брони раньше или позже. */
export function gridHours(day: ViewerDayDto): { from: number; to: number } {
  const { start } = zonedDayRange(day.date, day.timezone);
  const dayStart = start.getTime();
  let from = 8;
  let to = 22;
  for (const b of day.bookings) {
    const s = Math.max(0, (Date.parse(b.startsAt) - dayStart) / 3_600_000);
    const e = Math.min(24, (Date.parse(b.endsAt) - dayStart) / 3_600_000);
    from = Math.min(from, Math.floor(s));
    to = Math.max(to, Math.ceil(e));
  }
  return { from: Math.max(0, from), to: Math.min(24, to) };
}

/** Сколько показывать внутри блока календаря: по высоте блока в пикселях. */
export function blockSize(heightPx: number): 'sm' | 'md' | 'lg' {
  return heightPx < 56 ? 'sm' : heightPx < 120 ? 'md' : 'lg';
}
