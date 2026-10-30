import type { DealFieldMapDto } from '@btx24/shared';

/** Даты брони и визита в системных полях сделки (те, что настроены на портале). */
export function dealDateFields(m: DealFieldMapDto, s: Date, e: Date, tz: string): Record<string, string> {
  const f: Record<string, string> = {};
  const put = (code: string | undefined, v: string) => {
    if (code) f[code] = v;
  };
  put(m.bookingStart, zonedIso(s, tz));
  put(m.bookingEnd, zonedIso(e, tz));
  put(m.visitDateStart, dateRu(s, tz));
  put(m.visitTimeStart, timeRu(s, tz));
  put(m.visitDateEnd, dateRu(e, tz));
  put(m.visitTimeEnd, timeRu(e, tz));
  return f;
}

export function dateRu(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('ru-RU', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
}
export function timeRu(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('ru-RU', { timeZone, hour: '2-digit', minute: '2-digit' }).format(d);
}
/** «2026-10-23T14:00:00+03:00» — время в поясе портала со смещением (для полей «дата/время»). */
export function zonedIso(d: Date, timeZone: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const off = Math.round((local - d.getTime()) / 60000);
  const sign = off >= 0 ? '+' : '-';
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
  const mm = String(Math.abs(off) % 60).padStart(2, '0');
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sign}${hh}:${mm}`;
}
