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
 * Время брони по умолчанию по режиму группы: «часы от клика» — с `time` на `durationMinutes`;
 * «заезд/выезд» — заезд в `checkInTime`, выезд через `defaultNights` суток в `checkOutTime`.
 */
export function defaultPeriod(group: Pick<MyGroupDto, 'bookingMode' | 'durationMinutes' | 'checkInTime' | 'checkOutTime' | 'defaultNights'>, date: string, time = '14:00'): PeriodFields {
  if (group.bookingMode === 'interval')
    return {
      startDate: date,
      startTime: group.checkInTime,
      endDate: shiftDate(date, Math.max(1, group.defaultNights)),
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
