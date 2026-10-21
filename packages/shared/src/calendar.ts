/** Контракт `GET /api/calendar?date=YYYY-MM-DD` (apps/api CalendarController). */
export interface CalendarResource {
  id: number;
  name: string;
}

export interface CalendarDeal {
  id: number;
  title: string;
  categoryId: number | null;
  stageId: string | null;
  opportunity: number | null;
  currency: string | null;
}

/** Поле сделки, настроенное в группе (`options.dealFields`), уже в виде для показа. */
export interface CalendarField {
  code: string;
  label: string;
  value: string;
  /** Показывать в списке и на календаре (флаг «О» прототипа). */
  inList: boolean;
  /** Показывать в карточке брони (флаг «П»). */
  inView: boolean;
}

/** Тех. окно после брони: `[конец брони, конец + techWindowMinutes)`. Только предупреждает. */
export interface CalendarTechWindow {
  resourceId: number;
  start: string;
  end: string;
  bookingId: number;
}

export interface CalendarBooking {
  id: number;
  name: string;
  description: string | null;
  resourceIds: number[];
  /** ISO-8601, UTC. */
  start: string;
  end: string;
  /** ID связанной сделки (externalData crm/DEAL), если есть. */
  dealId: number | null;
  /** Данные сделки; null — сделки нет или у пользователя нет к ней доступа. */
  deal: CalendarDeal | null;
  /** Поля сделки по настройке группы; пусто без права на данные броней. */
  fields: CalendarField[];
}

export interface CalendarDay {
  date: string;
  /** Часовой пояс портала, в котором считается день и показывается время. */
  timezone: string;
  resources: CalendarResource[];
  bookings: CalendarBooking[];
  techWindows: CalendarTechWindow[];
}

/**
 * Тех. окна после броней: по одному на каждый ресурс брони (из `resourceIds`, если задан).
 * Окно, целиком перекрытое следующей бронью того же ресурса, не нужно — его не возвращаем.
 */
export function techWindowsFor(
  bookings: Pick<CalendarBooking, 'id' | 'resourceIds' | 'start' | 'end'>[],
  minutes: number,
  resourceIds?: Iterable<number>,
): CalendarTechWindow[] {
  if (!(minutes > 0)) return [];
  const allowed = resourceIds ? new Set(resourceIds) : null;
  const out: CalendarTechWindow[] = [];
  for (const b of bookings) {
    const startMs = Date.parse(b.end);
    const endMs = startMs + minutes * 60_000;
    for (const resourceId of b.resourceIds) {
      if (allowed && !allowed.has(resourceId)) continue;
      const covered = bookings.some(
        (o) =>
          o !== b && o.resourceIds.includes(resourceId) && Date.parse(o.start) <= startMs && Date.parse(o.end) >= endMs,
      );
      if (!covered) out.push({ resourceId, start: b.end, end: new Date(endMs).toISOString(), bookingId: b.id });
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start) || a.resourceId - b.resourceId);
}
