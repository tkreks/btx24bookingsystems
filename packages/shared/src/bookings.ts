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

/**
 * Системные поля сделки: что приложение заполняет при брони и по чему ищет прошлые брони клиента.
 * Коды полей свои у каждого портала — настраиваются (⚙ → «Приложение»), есть автоопределение по
 * названиям полей.
 */
export const DEAL_FIELD_ROLES = {
  bookingId: 'ID Бронирования',
  bookingStart: 'Дата и время начала бронирования',
  bookingEnd: 'Дата и время завершения бронирования',
  visitDateStart: 'Дата начала визита',
  visitTimeStart: 'Время начала визита',
  visitDateEnd: 'Дата завершения визита',
  visitTimeEnd: 'Время завершения визита',
  guests: 'Количество гостей',
  bookingType: 'Тип бронирования',
  managerComment: 'Комментарий менеджера',
  prepayment: 'Ручная сумма предоплаты',
  surcharge: 'Ручная сумма доплаты',
  prepaymentInvoiceId: 'ID Счёта на предоплату',
  prepaymentLink: 'Ссылка на предоплату',
  surchargeInvoiceId: 'ID Счёта на доплату',
  surchargeLink: 'Ссылка на доплату',
} as const;
export type DealFieldRole = keyof typeof DEAL_FIELD_ROLES;
export type DealFieldMapDto = Partial<Record<DealFieldRole, string>>;

/** Бронь клиента (в чате) или сделки (встройка): прошлая, текущая или будущая. */
export interface ClientBookingDto {
  /** null — бронь известна только по полям сделки (в модуле бронирования уже нет). */
  bookingId: number | null;
  dealId: number | null;
  deal: { title: string; stageSemantic: 'P' | 'S' | 'F' | null; opportunity: number | null } | null;
  start: string;
  end: string;
  resources: string[];
  /** ID ресурсов Битрикс24 — встройка сделки выбирает по ним группу календаря. */
  resourceIds: number[];
  when: 'past' | 'now' | 'future';
}

export interface ClientBookingsDto {
  contactId: number | null;
  /** Клиент (контакт CRM): имя, если записано. */
  contact: { id: number; name: string | null } | null;
  /** Выигранные сделки клиента (только успешные, не в работе): сколько и средний чек. */
  won: { count: number; avgCheck: number | null; currency: string | null };
  past: number;
  /** Текущие и будущие — ближайшие сверху. */
  upcoming: ClientBookingDto[];
  /** Последние прошлые (до 5). */
  recent: ClientBookingDto[];
  /** Открытые сделки клиента — для привязки новой брони. */
  openDeals: { id: number; title: string; categoryId: number | null }[];
}

/** Сценарий оплаты брони (ADR 0008). */
export const PAYMENT_MODES = ['prepayment', 'cash_on_site', 'postpay', 'free', 'certificate'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];
export const PAYMENT_MODE_LABELS: Record<PaymentMode, string> = {
  prepayment: 'Предоплата по ссылке',
  cash_on_site: 'Предоплата наличными на месте',
  postpay: 'Без предоплаты',
  free: 'Бесплатно',
  certificate: 'Сертификат',
};

/** Сценарии без оплаты вперёд (решение владельца 2026-10-22): только с правами создавать брони и сделки. */
export const RESTRICTED_PAYMENT_MODES: readonly PaymentMode[] = ['postpay', 'free'];

export function canUsePaymentMode(permissions: readonly string[], mode: PaymentMode): boolean {
  return !RESTRICTED_PAYMENT_MODES.includes(mode) || (permissions.includes('booking.create') && permissions.includes('deal.create'));
}

/** `POST /api/bookings` — создать бронь (сага: сделка → бронь → связь → поля сделки → товары). */
export interface CreateBookingDto {
  /** Ключ идемпотентности: повтор с тем же ключом вернёт тот же результат. */
  idempotencyKey: string;
  groupId: string;
  kind: 'client' | 'service';
  resourceIds: number[];
  /** UTC, ISO; интервал [start, end). */
  start: string;
  end: string;
  /** Существующая сделка — или `newDeal` (новая в воронке группы). Служебная бронь — без сделки. */
  dealId?: number | null;
  newDeal?: { title: string; contactId?: number | null } | null;
  contactId?: number | null;
  guests?: number | null;
  comment?: string;
  /** Товары сделки (заменяют строки сделки, как в прототипе); цена — вручную. Пусто — не трогать. */
  products?: { productId: number; quantity: number; price: number }[];
  paymentMode: PaymentMode;
  /** Тип брони, выбранный менеджером (id правила группы); не задан — по товарам сделки, как в БП 270. */
  bookingTypeId?: string | null;
  /** Поля сделки группы (флаг «С»): код → значение формы (`DealFormField.value`). */
  dealFields?: Record<string, string>;
}

export interface CreateBookingResultDto {
  bookingId: number;
  dealId: number | null;
  /** Тип брони по товарам (для сообщения клиенту); null — не определён. */
  bookingType: string | null;
  warnings: string[];
}

/** Вид поля сделки в форме (из типа `crm.deal.fields`). */
export type DealFormFieldKind = 'string' | 'number' | 'money' | 'enum' | 'boolean' | 'date' | 'datetime';

/**
 * Поле сделки группы для формы брони и правки в карточке (`options.dealFields` + `crm.deal.fields`).
 * Значение — строкой, как в поле ввода: число «1500», список — ID варианта, да/нет — «Y»/«N»,
 * дата — «YYYY-MM-DD», дата и время — «YYYY-MM-DDTHH:MM» в поясе портала.
 */
export interface DealFormField {
  code: string;
  label: string;
  kind: DealFormFieldKind;
  required: boolean;
  /** Не редактируется: поле только для чтения в CRM, множественное/составное или его заполняет приложение. */
  readOnly: boolean;
  /** Два в строку: поле и следующее — в одной строке. */
  inlineNext: boolean;
  /** «С» — в форме создания брони; «П» — в карточке брони. */
  showCreate: boolean;
  showView: boolean;
  items?: { id: string; value: string }[];
  /** Системная роль поля (⚙ → «Приложение»): гости, комментарий менеджера… */
  role: DealFieldRole | null;
  /** Из настроек группы: значение по умолчанию и формула (форма создания и правки). */
  defaultValue?: string;
  formula?: string;
  value: string;
  /** Значение для показа, если поле не редактируется (списки, составные). */
  display: string;
}

/** `GET /api/deal-form?groupId=&dealId=` — поля сделки группы и значения сделки (если указана). */
export interface DealFormDto {
  groupId: string;
  dealId: number | null;
  currency: string;
  fields: DealFormField[];
}

/** `PUT /api/deals/:dealId/fields` — правка полей сделки из карточки брони (только изменённые). */
export interface UpdateDealFieldsDto {
  groupId: string;
  values: Record<string, string>;
}

/** `POST /api/bookings/:bookingId/cancel` `{ groupId, comment? }` — снять бронь (Битрикс24 + журнал). */
export interface CancelBookingResultDto {
  bookingId: number;
  warnings: string[];
}
