import { zonedTimeToUtc, type MyGroupDto } from '@btx24/shared';
import { shiftDate } from '../format.js';

/** Поля формы: дата и время в поясе портала (как вводит менеджер). */
export interface PeriodFields {
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
}

/**
 * Группа «по дням» (беседки, решение владельца 2026-10-26): «заезд/выезд» с 0 в «Минимум дней» и выездом
 * позже заезда — бронь в тот же день (10:00–22:00), при желании на несколько дней.
 */
export function byDays(group: Pick<MyGroupDto, 'bookingMode' | 'checkInTime' | 'checkOutTime' | 'defaultNights'>): boolean {
  return group.bookingMode === 'interval' && group.defaultNights === 0 && group.checkOutTime > group.checkInTime;
}

/**
 * Время брони по умолчанию по режиму группы: «часы от клика» — с `time` на `durationMinutes`;
 * «заезд/выезд» — заезд в `checkInTime`, выезд через `defaultNights` суток в `checkOutTime` (группа «по
 * дням» — в тот же день).
 */
export function defaultPeriod(group: Pick<MyGroupDto, 'bookingMode' | 'durationMinutes' | 'checkInTime' | 'checkOutTime' | 'defaultNights'>, date: string, time = '14:00'): PeriodFields {
  if (group.bookingMode === 'interval')
    return {
      startDate: date,
      startTime: group.checkInTime,
      endDate: shiftDate(date, byDays(group) ? 0 : Math.max(1, group.defaultNights)),
      endTime: group.checkOutTime,
    };
  const [h, m] = time.split(':').map(Number);
  const total = h * 60 + m + Math.max(1, group.durationMinutes);
  const days = Math.floor(total / 1440);
  const rest = total % 1440;
  return {
    startDate: date,
    startTime: time,
    endDate: shiftDate(date, days),
    endTime: `${String(Math.floor(rest / 60)).padStart(2, '0')}:${String(rest % 60).padStart(2, '0')}`,
  };
}

/** В UTC (ISO) для API; ошибка — текст для формы. */
export function periodToUtc(p: PeriodFields, timeZone: string): { start: string; end: string } | { error: string } {
  if (!p.startDate || !p.startTime || !p.endDate || !p.endTime) return { error: 'Укажите начало и конец брони' };
  const start = zonedTimeToUtc(p.startDate, p.startTime, timeZone);
  const end = zonedTimeToUtc(p.endDate, p.endTime, timeZone);
  if (end.getTime() <= start.getTime()) return { error: 'Конец брони должен быть позже начала' };
  return { start: start.toISOString(), end: end.toISOString() };
}

/** Дата и время `HH:MM` момента `ms` в поясе портала. */
export function localAt(ms: number, timeZone: string): { date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/**
 * Время брони по умолчанию, но не в прошлом (решение владельца 2026-10-26): начало по умолчанию уже
 * прошло (сегодня после 14:00) — начало с ближайших получаса; у «часов» конец — через длительность группы,
 * у «заезд/выезд» выезд остаётся (14:00 → 12:00 завтра).
 */
export function upcomingPeriod(
  group: Pick<MyGroupDto, 'bookingMode' | 'durationMinutes' | 'checkInTime' | 'checkOutTime' | 'defaultNights'>,
  date: string,
  time: string | undefined,
  now: number,
  timeZone: string,
): PeriodFields {
  const p = defaultPeriod(group, date, time);
  if (zonedTimeToUtc(p.startDate, p.startTime, timeZone).getTime() >= now) return p;
  const step = 30 * 60_000;
  const at = localAt(Math.ceil(now / step) * step, timeZone);
  // Другой день (выбрали прошедший) — время по умолчанию остаётся, проверка покажет «в прошлом».
  if (at.date !== date) return p;
  if (group.bookingMode !== 'interval') return defaultPeriod(group, at.date, at.time);
  const q = { ...p, startTime: at.time };
  return 'error' in periodToUtc(q, timeZone) ? { ...q, endDate: shiftDate(q.endDate, 1) } : q;
}

/** Период с тем же началом и длительностью `minutes`. */
export function withDuration(p: PeriodFields, minutes: number, timeZone: string): PeriodFields {
  const end = localAt(zonedTimeToUtc(p.startDate, p.startTime, timeZone).getTime() + minutes * 60_000, timeZone);
  return { ...p, endDate: end.date, endTime: end.time };
}

/** Быстрый выбор длительности, ч: по умолчанию группы и ещё три часа сверху (бани: 4, 5, 6, 7). */
export function durationChoices(defaultMinutes: number): number[] {
  const base = Math.max(1, Math.round(defaultMinutes / 60));
  return [base, base + 1, base + 2, base + 3];
}

/** «4 ч», «1 сут 2 ч», «45 мин» — длительность брони. */
export function durationText(ms: number): string {
  const min = Math.round(ms / 60_000);
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  return [d ? `${d} сут` : '', h ? `${h} ч` : '', m ? `${m} мин` : ''].filter(Boolean).join(' ') || '0 мин';
}

/** «1 день», «2 дня», «5 дней». */
export function daysText(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  return `${n} ${m10 === 1 && m100 !== 11 ? 'день' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'дня' : 'дней'}`;
}
