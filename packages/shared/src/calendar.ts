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
}

export interface CalendarDay {
  date: string;
  /** Часовой пояс портала, в котором считается день и показывается время. */
  timezone: string;
  resources: CalendarResource[];
  bookings: CalendarBooking[];
}
