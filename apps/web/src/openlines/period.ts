import { DASHBOARD_MAX_DAYS } from '@btx24/shared';
import { shiftDate } from '../format.js';

export type PeriodPreset = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'custom';

export const PERIOD_PRESETS: { key: PeriodPreset; label: string }[] = [
  { key: 'today', label: 'Сегодня' },
  { key: 'yesterday', label: 'Вчера' },
  { key: '7d', label: '7 дней' },
  { key: '30d', label: '30 дней' },
  { key: 'month', label: 'Этот месяц' },
  { key: 'custom', label: 'Период…' },
];

/** Дни `[from, to]` пресета относительно сегодняшней даты портала. `custom` — без изменений. */
export function presetRange(preset: Exclude<PeriodPreset, 'custom'>, today: string): { from: string; to: string } {
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday':
      return { from: shiftDate(today, -1), to: shiftDate(today, -1) };
    case '7d':
      return { from: shiftDate(today, -6), to: today };
    case '30d':
      return { from: shiftDate(today, -29), to: today };
    case 'month':
      return { from: `${today.slice(0, 8)}01`, to: today };
  }
}

/** Ошибка произвольного периода для подсказки у полей или null. */
export function periodError(from: string, to: string): string | null {
  if (!from || !to) return 'Укажите обе даты';
  if (to < from) return 'Начало позже конца';
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
  return days > DASHBOARD_MAX_DAYS ? `Не длиннее ${DASHBOARD_MAX_DAYS} дней` : null;
}
