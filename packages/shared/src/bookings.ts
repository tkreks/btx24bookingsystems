import type { DealBookingTone, DealStatusDto } from './deal-status.js';
/** Контракты броней приложения: уведомления (новая бронь мимо приложения, расхождения) и история. */

export const ALERT_STATUSES = ['new', 'viewed', 'resolved', 'ignored'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export const ALERT_STATUS_LABELS: Record<AlertStatus, string> = {
  new: 'Новый',
  viewed: 'В работе',
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

/** Тип уведомления для показа: новая бронь, изменение (оранжевым), удаление (красным), не снята. */
export type AlertType = 'new_booking' | 'change' | 'removal' | 'not_cancelled';
export const ALERT_TYPE_LABELS: Record<AlertType, string> = {
  new_booking: 'Новое бронирование',
  change: 'Изменение в Битрикс24',
  removal: 'Удаление в Битрикс24',
  not_cancelled: 'Не снята в Битрикс24',
};
export function alertType(a: { kind: AlertKind; problems: AlertProblem[] }): AlertType {
  if (a.kind === 'new_booking') return 'new_booking';
  if (a.problems.includes('missing')) return 'removal';
  if (a.problems.includes('not_cancelled')) return 'not_cancelled';
  return 'change';
}

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
  /** Название брони (сделка или бронь в Битрикс24). */
  title: string | null;
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

/**
 * `POST /api/booking-alerts/:id/resolve` `{ resolution, versionId? }` — решение по уведомлению:
 * - `accept_bitrix` — «Принять»: данные Битрикс24 становятся данными приложения (бронь пропала —
 *   удалить в приложении; не снята — снова активна; новая — принять как есть);
 * - `rollback` — «Откатить» к версии `versionId` из истории: бронь в Битрикс24 возвращается к ней
 *   (пропала — создаётся заново по ней); новая или не снятая — удаляется в Битрикс24;
 * - `recreate` — пропавшую бронь создать заново по текущим данным приложения;
 * - `cancel_booking` — удалить в Битрикс24 и отменить у нас.
 */
export type AlertResolution = 'accept_bitrix' | 'cancel_booking' | 'recreate' | 'rollback';

/** Версия данных брони из истории приложения (снимок после действия) — для «Откатить». */
export interface BookingVersionDto {
  /** ID записи истории: по нему откат. */
  id: string;
  at: string;
  action: string;
  actorName: string | null;
  state: BookingStateDto;
  /** Совпадает с текущими данными приложения. */
  current: boolean;
}

/** `GET /api/bookings/:bookingId/versions?offset&limit` — новые сверху, по 3. */
export interface BookingVersionsDto {
  bookingId: number;
  items: BookingVersionDto[];
  hasMore: boolean;
}

/** `POST /api/bookings/:bookingId/recreate` — бронь создана в Битрикс24 заново (новый ID). */
export interface RecreateBookingResultDto {
  previousBookingId: number;
  bookingId: number;
  warnings: string[];
}

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
  /** «Бронирование сертификатом»: сумма ссылки на оплату, если менеджер решил её отправить. */
  prepaymentAmount: 'Сумма предоплаты',
  surcharge: 'Ручная сумма доплаты',
  prepaymentInvoiceId: 'ID Счёта на предоплату',
  prepaymentLink: 'Ссылка на предоплату',
  surchargeInvoiceId: 'ID Счёта на доплату',
  surchargeLink: 'Ссылка на доплату',
  /** Пересчитывается приложением: сумма проведённых оплат по всем счетам сделки. */
  paidAmount: 'Сумма внесённых оплат',
  /** Вид сделки: бронь, покупка сертификата (`CERTIFICATE_DEAL_TYPE`), бронь сертификатом. */
  dealType: 'Тип сделки',
} as const;
export type DealFieldRole = keyof typeof DEAL_FIELD_ROLES;
/**
 * Значение поля «Тип сделки» у покупки сертификата: покупают не бронь, а сертификат на сумму, которой
 * потом оплачивают бронь. Оплаченная (и не проигранная) — успешная сделка, хотя брони у неё нет.
 */
export const CERTIFICATE_DEAL_TYPE = 'Покупка сертификата';

/**
 * Тип сделки в мастере брони (решение владельца 2026-10-23, группа «Бани» — опция `dealKinds`): от него
 * зависят шаги, поля и оплата. Значение поля «Тип сделки» ищется по началу названия варианта.
 */
export const DEAL_KINDS = ['certificate', 'visit', 'by_certificate', 'no_payment'] as const;
export type DealKind = (typeof DEAL_KINDS)[number];
export const DEAL_KIND_LABELS: Record<DealKind, string> = {
  certificate: 'Покупка сертификата',
  visit: 'Бронирование посещения',
  by_certificate: 'Бронирование сертификатом',
  no_payment: 'Бронирование без оплаты',
};
export const DEAL_KIND_HINTS: Record<DealKind, string> = {
  certificate: 'сумма, бумажный или электронный, на чьё имя — и ссылка на оплату',
  visit: 'дата, ресурс и время, тип бронирования, поля — и ссылка на предоплату с таймером',
  by_certificate: 'как посещение; ссылку на оплату — по решению на последнем шаге',
  no_payment: 'дата, ресурс и время, остальные поля группы',
};
/** Вариант поля «Тип сделки» (начало названия). «Без оплаты» в списке нет — это бронь посещения. */
export const DEAL_KIND_TYPE_VALUE: Record<DealKind, string> = {
  certificate: CERTIFICATE_DEAL_TYPE,
  visit: 'Бронирование посещения',
  by_certificate: 'Бронирование сертификатом',
  no_payment: 'Бронирование посещения',
};
/** Оплата брони по типу сделки; для «сертификатом» — `certificate`, со ссылкой — `prepayment`. */
export const DEAL_KIND_PAYMENT: Record<Exclude<DealKind, 'certificate'>, PaymentMode> = {
  visit: 'prepayment',
  by_certificate: 'certificate',
  no_payment: 'postpay',
};
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
  /**
   * Открытые сделки клиента — для привязки новой брони: сумма, когда создана, бронь по сделке
   * (текущая или будущая; мастер выделяет такую сделку красным).
   */
  openDeals: {
    id: number;
    title: string;
    categoryId: number | null;
    opportunity?: number | null;
    createdAt?: string | null;
    booking?: { start: string; end: string; resources: string[] } | null;
    tone?: DealBookingTone;
    status?: DealStatusDto | null;
  }[];
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
  products?: BookingProductInput[];
  paymentMode: PaymentMode;
  /** Тип брони, выбранный менеджером (id правила группы); не задан — по товарам сделки, как в БП 270. */
  bookingTypeId?: string | null;
  /** Поля сделки группы (флаг «С»): код → значение формы (`DealFormField.value`). */
  dealFields?: Record<string, string>;
  /** Тип сделки из мастера (группы с `dealKinds`): заполняет поле «Тип сделки». */
  dealKind?: DealKind | null;
  /** «Бронирование сертификатом» со ссылкой на оплату: сумма — в поле «Сумма предоплаты». */
  prepaymentAmount?: number | null;
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
  /** «Сумма предоплаты» сделки (бронирование сертификатом — сумма ссылки); null — пусто или нет поля. */
  prepaymentAmount?: number | null;
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

/** `GET /api/booking-catalog?groupId=` — товары группы (разделы каталога из настроек) для формы брони. */
export interface BookingCatalogDto {
  products: { id: number; name: string; price: number | null; currency: string | null; section: string | null; sectionId?: string | null }[];
  /** Быстрые теги мастера: выбранные разделы группы с открытым 👁 (по порядку настройки). */
  sections?: { id: string; name: string; /** Раздел и вложенные. */ sectionIds: string[] }[];
  /** resourceId → товары по умолчанию (⚙ → группа → ресурсы). */
  defaults: Record<string, { productId: number; quantity: number }[]>;
  /** false — разделы в группе не выбраны: показаны все активные товары. */
  restricted: boolean;
}

/** Скидка строки товара: в процентах или суммой (на единицу), как в Битрикс24. */
export type ProductDiscountType = 'percent' | 'sum';

/**
 * Товар брони: `price` — цена за единицу без скидки; скидка — процент или сумма на единицу. В
 * Битрикс24 уходит итоговая цена (`PRICE`) и поля скидки (`DISCOUNT_TYPE_ID/RATE/SUM`).
 */
export interface BookingProductInput {
  productId: number;
  quantity: number;
  price: number;
  discountType?: ProductDiscountType;
  /** Процент (0–100) или сумма на единицу — по `discountType`. */
  discount?: number;
}

/** Строка товаров сделки (`GET /api/deals/:dealId/products`) — форма брони заменяет строки целиком. */
export interface DealProductRowDto {
  productId: number;
  name: string;
  /** Цена за единицу без скидки. */
  price: number;
  quantity: number;
  discountType: ProductDiscountType;
  discount: number;
}

/** Итоговая цена за единицу после скидки (до копеек, не меньше 0). */
export function discountedPrice(p: Pick<BookingProductInput, 'price' | 'discountType' | 'discount'>): number {
  const d = Math.max(0, p.discount ?? 0);
  const net = p.discountType === 'sum' ? p.price - d : p.price * (1 - Math.min(d, 100) / 100);
  return Math.max(0, Math.round(net * 100) / 100);
}

/** Поиск клиента в форме брони (`GET /api/crm/search?kind=contact&q=`): ID, телефон, e-mail, ФИО. */
export interface CrmContactHit {
  id: number;
  name: string;
  phones: string[];
  emails: string[];
}

/** Поиск сделки (`kind=deal`): название, ID или имя клиента; открытые — первыми. */
export interface CrmDealHit {
  id: number;
  title: string;
  categoryId: number | null;
  closed: boolean;
  opportunity: number | null;
  currency: string | null;
  contact: { id: number; name: string | null } | null;
  createdAt: string | null;
  /** Последняя активность по сделке (чаты, звонки, дела — `LAST_ACTIVITY_TIME`). */
  lastActivityAt: string | null;
  /** Цвет для выбора сделки новой брони (бронь есть / поля заполнены / пустая). */
  tone?: DealBookingTone;
}

export interface CrmSearchDto {
  contacts: CrmContactHit[];
  deals: CrmDealHit[];
}

/** `GET /api/crm/recent-deals` — 20 открытых сделок с последней активностью (воронки групп сотрудника). */
export interface RecentDealsDto {
  deals: CrmDealHit[];
}
