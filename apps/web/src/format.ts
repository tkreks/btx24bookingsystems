// Отображение времени — всегда в часовом поясе портала, а не браузера.

export function fmtTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('ru-RU', { timeZone, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

export function fmtDateTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('ru-RU', { timeZone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

/** «23.10.2026». */
export function fmtDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('ru-RU', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(iso));
}

export function fmtDayTitle(date: string, timeZone: string): string {
  return new Intl.DateTimeFormat('ru-RU', { timeZone, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${date}T12:00:00Z`));
}

export function fmtMoney(amount: number | null, currency: string | null): string {
  if (amount === null) return '';
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(amount)} ${currency === 'RUB' || !currency ? '₽' : currency}`;
}

/** YYYY-MM-DD ± n дней (календарная арифметика, без часовых поясов). */
export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** «сегодня в 18:11», «вчера в 18:15», раньше — «21.10 18:11» (пояс портала). */
export function fmtWhen(iso: string, timeZone: string, now = new Date()): string {
  const day = (x: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone }).format(x);
  const d = day(new Date(iso));
  const today = day(now);
  if (d === today) return `сегодня в ${fmtTime(iso, timeZone)}`;
  if (d === shiftDate(today, -1)) return `вчера в ${fmtTime(iso, timeZone)}`;
  return fmtDateTime(iso, timeZone).replace(',', '');
}

/** Длительность: «0:45», «12:05», «1:02:30». */
export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Время на дашборде: за один день — только время, за период — с датой. */
export function fmtAt(iso: string, timeZone: string, oneDay: boolean): string {
  return oneDay ? fmtTime(iso, timeZone) : fmtDateTime(iso, timeZone);
}

/** Дата через `months` месяцев (последний день месяца, если такого числа нет): «2026-10-31» + 1 → «2026-11-30». */
export function plusMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + months, Math.min(d, last))).toISOString().slice(0, 10);
}
