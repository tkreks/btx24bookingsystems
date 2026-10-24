import { BadRequestException } from '@nestjs/common';
import { isIsoDate, zonedDayRange } from '@btx24/shared';

/** Даты включительно в поясе портала → полуоткрытый UTC-интервал. */
export function selectedPeriod(query: { from?: unknown; to?: unknown }, timezone: string): { from: string; to: string; start: Date; end: Date } | null {
  if (query.from === undefined && query.to === undefined) return null;
  const { from, to } = query;
  if (typeof from !== 'string' || typeof to !== 'string' || !isIsoDate(from) || !isIsoDate(to) || to < from || Date.parse(to) - Date.parse(from) > 91 * 86400000)
    throw new BadRequestException({ code: 'INVALID_PERIOD', message: 'Укажите период YYYY-MM-DD, не более 92 дней' });
  return { from, to, start: zonedDayRange(from, timezone).start, end: zonedDayRange(to, timezone).end };
}
