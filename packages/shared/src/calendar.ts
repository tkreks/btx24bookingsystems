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
  /**
   * Бронь приложения, которой больше нет в Битрикс24: показывается до решения сотрудника
   * (создать заново или удалить в приложении). `alertId` — уведомление о расхождении, если уже есть.
   */
  missing?: { alertId: string | null };
}

export interface CalendarDay {
  date: string;
  /** Часовой пояс портала, в котором считается день и показывается время. */
  timezone: string;
  resources: CalendarResource[];
  bookings: CalendarBooking[];
  techWindows: CalendarTechWindow[];
  /** Стопы ресурсов, пересекающие день: ресурс закрыт для бронирования. */
  stops?: ResourceStopDto[];
}

/** Шкала броней: период — не больше стольких месяцев (решение владельца 2026-10-29). */
export const TIMELINE_MAX_MONTHS = 30;

/**
 * `GET /api/calendar/range?groupId=&from=YYYY-MM-DD&to=YYYY-MM-DD` — брони ресурсов группы за период из
 * журнала приложения (сверка с Битрикс24 по событиям и раз в 10 минут), без запросов к модулю
 * бронирования: шкала дашборда и встройки. Дни `from`…`to` включительно, не больше `TIMELINE_MAX_MONTHS`.
 */
export interface CalendarRangeDto {
  from: string;
  to: string;
  timezone: string;
  resources: CalendarResource[];
  bookings: CalendarBooking[];
  techWindows: CalendarTechWindow[];
  stops: ResourceStopDto[];
  /** Последняя сверка журнала с Битрикс24 (ISO); null — ещё не было. */
  syncedAt: string | null;
  /** До какого дня (YYYY-MM-DD) журнал сверяется с Битрикс24; позже брони из Битрикс24 могут быть не видны. */
  horizon: string | null;
}

/** Дата через `months` месяцев (31-е в коротком месяце — его последний день). */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${String(ny).padStart(4, '0')}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/**
 * Стоп ресурса (решение владельца 2026-10-23): ресурс недоступен для бронирования с дня `from` по день
 * `to` включительно; ставится, только если броней в этот период нет.
 */
export interface ResourceStopDto {
  id: string;
  resourceId: number;
  /** Дни портала (YYYY-MM-DD), включительно. */
  from: string;
  to: string;
  /** Границы периода (UTC, ISO), `[start, end)`. */
  start: string;
  end: string;
  reason: string;
  createdBy: string;
  createdAt: string;
}

/** `POST /api/resource-stops/check` и ответ 409 на установку: брони ресурса в периоде. */
export interface ResourceStopCheckDto {
  resourceId: number;
  from: string;
  to: string;
  bookings: { id: number; name: string; start: string; end: string; dealId: number | null }[];
  /** Уже действующие стопы ресурса в этом периоде. */
  stops: ResourceStopDto[];
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
