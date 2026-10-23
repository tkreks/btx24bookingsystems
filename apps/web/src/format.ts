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
