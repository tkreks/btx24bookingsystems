// Работа с «днём» в часовом поясе портала без сторонних библиотек (Intl есть и в Node, и в браузере).
// В БД и API время — UTC; день — понятие часового пояса (CONTRIBUTING §4).

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Смещение пояса от UTC в минутах в момент `instant` (например, +180 для Europe/Moscow). */
export function tzOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

/** Момент (UTC), соответствующий локальным дате и времени в поясе. Учитывает переход на летнее время. */
export function zonedTimeToUtc(date: string, time: string, timeZone: string): Date {
  const m = DATE_RE.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m || !t) throw new Error(`Invalid local date/time: ${date} ${time}`);
  const naive = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(t[1]), Number(t[2]));
  // Две итерации сходятся и вблизи перехода смещения.
  let guess = naive - tzOffsetMinutes(new Date(naive), timeZone) * 60_000;
  guess = naive - tzOffsetMinutes(new Date(guess), timeZone) * 60_000;
  return new Date(guess);
}

/** Границы суток `date` (YYYY-MM-DD) в поясе: полуоткрытый интервал [start, end). */
export function zonedDayRange(date: string, timeZone: string): { start: Date; end: Date } {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`Invalid date: ${date}`);
  const next = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1)).toISOString().slice(0, 10);
  return { start: zonedTimeToUtc(date, '00:00', timeZone), end: zonedTimeToUtc(next, '00:00', timeZone) };
}

/** Сегодняшняя дата (YYYY-MM-DD) в поясе. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function isIsoDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}
