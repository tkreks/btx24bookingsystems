/** Контракты броней приложения: уведомления (новая бронь мимо приложения, расхождения) и история. */

export const ALERT_STATUSES = ['new', 'viewed', 'resolved', 'ignored'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export const ALERT_STATUS_LABELS: Record<AlertStatus, string> = {
  new: 'Новый',
  viewed: 'Просмотрен',
  resolved: 'Решено',
  ignored: 'Игнорировать',
};

export type AlertKind = 'new_booking' | 'discrepancy';
/** Что не совпало у брони приложения с Битрикс24. */
export type AlertProblem = 'missing' | 'time' | 'resources' | 'deal' | 'not_cancelled';

export const ALERT_PROBLEM_LABELS: Record<AlertProblem, string> = {
  missing: 'брони нет в Битрикс24',
  time: 'другое время',
  resources: 'другие ресурсы',
  deal: 'другая сделка',
  not_cancelled: 'отменена в приложении, но осталась в Битрикс24',
};

/** Состояние брони для сравнения «как в приложении» / «как в Битрикс24». */
export interface BookingStateDto {
  startsAt: string;
  endsAt: string;
  resourceIds: number[];
  dealId: number | null;
}

export interface BookingAlertDto {
  id: string;
  kind: AlertKind;
  problems: AlertProblem[];
  bookingId: number;
  dealId: number | null;
  expected: BookingStateDto | null;
  actual: (BookingStateDto & { title?: string | null }) | null;
  status: AlertStatus;
  statusBy: { id: number; name: string } | null;
  statusAt: string | null;
  createdAt: string;
  /** Отправлено ли в чат уведомлений (и почему нет). */
  delivered: boolean;
  sendError: string | null;
}

export interface BookingAlertListDto {
  items: BookingAlertDto[];
  counts: Record<AlertStatus, number>;
  /** ID ресурса → название (для «было/стало»). */
  resources: Record<string, string>;
  /** Чат уведомлений настроен. */
  chatConfigured: boolean;
}

/** `PUT /api/booking-alerts/:id` — смена статуса. */
export interface SetAlertStatusDto {
  status: AlertStatus;
}

/** `POST /api/booking-alerts/:id/resolve` — решение по расхождению. */
export type AlertResolution = 'accept_bitrix' | 'cancel_booking';

/** `GET/PUT /api/admin/booking-sync` — сверка с Битрикс24 и чат уведомлений. */
export interface BookingSyncSettingsDto {
  /** Чат уведомлений; null — ещё не создан. */
  alertChatId: number | null;
  /** На сколько дней вперёд сверять брони. */
  syncHorizonDays: number;
  /** Первая сверка (приём существующих броней без уведомлений) прошла. */
  baselineAt: string | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
}

/** Запись истории брони (аудит). */
export interface BookingHistoryEntryDto {
  at: string;
  action: string;
  actorKind: 'user' | 'system' | 'bitrix';
  actorName: string | null;
  via: string;
  before: BookingStateDto | null;
  after: BookingStateDto | null;
  details: unknown;
}

export interface BookingHistoryDto {
  bookingId: number;
  source: 'app' | 'bitrix';
  status: 'active' | 'cancelled';
  entries: BookingHistoryEntryDto[];
}
