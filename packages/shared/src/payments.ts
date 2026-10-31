// Счёт и ссылка на оплату (ADR 0009): приложение создаёт смарт-счёт сделки, ссылку на оплату в
// поле счёта ставит робот портала (платёжная система), приложение отправляет её клиенту и
// следит за оплатой до срока.

export const PAYMENT_KINDS = ['prepayment', 'surcharge'] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];
/**
 * Вид заявки на оплату: к предоплате и доплате группы добавлена «Произвольная» (решение владельца
 * 2026-10-26) — основание, сумма и срок задаёт сотрудник; стадию и поля оплаты сделки она не трогает.
 */
export const PAYMENT_REQUEST_KINDS = ['custom', 'prepayment', 'surcharge'] as const;
export type PaymentRequestKind = (typeof PAYMENT_REQUEST_KINDS)[number];
export const PAYMENT_KIND_LABELS: Record<PaymentRequestKind, string> = { custom: 'Произвольная', prepayment: 'Предоплата', surcharge: 'Доплата' };
/** Основание произвольной оплаты — быстрый выбор. */
export const PAYMENT_PURPOSES = ['Предоплата за бронирование', 'Доплата за бронирование', 'Дополнительные услуги', 'Сертификат', 'Аренда инвентаря'];

/**
 * link_pending — счёт создан, ждём ссылку от портала; sent — ссылка у клиента, ждём оплату;
 * paid — оплачено; expired — срок вышел (бронь снята); failed — не удалось; cancelled — снято вручную.
 */
export const PAYMENT_REQUEST_STATUSES = ['link_pending', 'sent', 'paid', 'expired', 'failed', 'cancelled'] as const;
export type PaymentRequestStatus = (typeof PAYMENT_REQUEST_STATUSES)[number];
export const PAYMENT_STATUS_LABELS: Record<PaymentRequestStatus, string> = {
  link_pending: 'Ссылка формируется',
  sent: 'Ждём оплату',
  paid: 'Оплачено',
  expired: 'Не оплачено в срок',
  failed: 'Ошибка',
  cancelled: 'Отменено',
};

/**
 * Статус счёта для интерфейса (решение владельца 2026-10-31): «Выставлен» (подготовлен, клиент ссылку
 * ещё не получил) — синий, «Ждёт оплату» (ссылка у клиента, срок идёт) — оранжевый, «Оплачен» — зелёный,
 * «Проигран» (закрыт неуспешно: просрочен, отменён, ошибка) — красный.
 */
export const INVOICE_DISPLAY_STATUSES = ['issued', 'waiting', 'paid', 'lost'] as const;
export type InvoiceDisplayStatus = (typeof INVOICE_DISPLAY_STATUSES)[number];
export const INVOICE_DISPLAY_LABELS: Record<InvoiceDisplayStatus, string> = {
  issued: 'Выставлен',
  waiting: 'Ждёт оплату',
  paid: 'Оплачен',
  lost: 'Проигран',
};

/**
 * Статус счёта по стадии в Битрикс24 и заявке приложения. Стадия Битрикс24 важнее: оплату и провал
 * фиксирует портал. Открытый счёт заявки — «Ждёт оплату», только когда ссылка действительно ушла
 * клиенту (`messageSent`), иначе он лишь «Выставлен»; счёт не приложения — «Ждёт оплату» (о доставке
 * ссылки ничего не известно, но счёт открыт).
 */
export function invoiceDisplayStatus(
  state: 'open' | 'paid' | 'failed',
  request: Pick<PaymentRequestDto, 'status' | 'messageSent'> | null,
): InvoiceDisplayStatus {
  if (state === 'paid') return 'paid';
  if (state === 'failed') return 'lost';
  if (!request) return 'waiting';
  if (request.status === 'paid') return 'paid';
  if (request.status === 'expired' || request.status === 'failed' || request.status === 'cancelled') return 'lost';
  return request.status === 'sent' && request.messageSent ? 'waiting' : 'issued';
}

/** Смарт-счёт (entityTypeId 31) направления: куда и с какими полями его создавать. */
export interface InvoiceConfig {
  categoryId: number;
  prepaymentStageId: string;
  surchargeStageId: string;
  /** Поле счёта, в которое портал ставит ссылку на оплату (`ufCrm_…`). */
  linkField: string;
  /** Постоянные поля счёта (`ufCrm_…` → значение), например «Тип счёта», «Тип сделки». */
  fields: Record<string, string | number>;
}

/** Текст по умолчанию: просьба о доплате (правится в настройках группы). */
export const DEFAULT_SURCHARGE_MESSAGE =
  'Просим внести доплату {prepayment} ₽ по ссылке: {link}\nПосле оплаты, пожалуйста, отправьте чек ответным сообщением.';

/** Откуда взята сумма: фиксированная группы, ручная из сделки, процент от суммы сделки. */
export type PaymentAmountSource = 'fixed' | 'manual' | 'percent' | 'certificate' | 'none';

/**
 * Сумма к оплате: предоплата — «ручная сумма предоплаты» сделки (как в БП прототипа — она
 * точнее всего), иначе фиксированная сумма группы, иначе процент от суммы сделки; доплата —
 * «ручная сумма доплаты».
 */
export function paymentAmount(
  kind: PaymentKind,
  input: { fixed?: number | null; manual?: number | null; opportunity?: number | null; percent?: number | null },
): { amount: number | null; source: PaymentAmountSource } {
  const pos = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  if (kind === 'surcharge') {
    const m = pos(input.manual);
    return m ? { amount: round2(m), source: 'manual' } : { amount: null, source: 'none' };
  }
  const manual = pos(input.manual);
  if (manual) return { amount: round2(manual), source: 'manual' };
  const fixed = pos(input.fixed);
  if (fixed) return { amount: round2(fixed), source: 'fixed' };
  const opp = pos(input.opportunity);
  const pct = pos(input.percent) ?? 100;
  return opp ? { amount: round2((opp * Math.min(pct, 100)) / 100), source: 'percent' } : { amount: null, source: 'none' };
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** «25000|RUB» (поле «деньги» сделки) → 25000. */
export function moneyValue(v: unknown): number | null {
  const n = Number(String(v ?? '').split('|')[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** `GET /api/payments/preview?dealId&kind` — что будет, если выставить счёт. */
export interface PaymentPreviewDto {
  dealId: number;
  kind: PaymentRequestKind;
  groupId: string | null;
  groupName: string | null;
  /** Группы, по которым можно выставить счёт (одна воронка — несколько групп); выбор — в окне. */
  groupOptions: { id: string; name: string }[];
  /** Шаблон сообщения: название системного шаблона; null — стандартный текст. */
  templateName: string | null;
  amount: number | null;
  source: PaymentAmountSource;
  /** Минут на оплату (только предоплата); null — без срока. */
  timeoutMinutes: number | null;
  /** Текст клиенту (ссылка — `{link}`, подставится после создания счёта). */
  message: string;
  /** Шаблон сообщения: id системного шаблона оплаты (`?templateId` или шаблон группы); null — стандартный текст. */
  templateId: string | null;
  /**
   * Текст для правки в окне: шаги шаблона одним текстом (через пустую строку), переменные сделки уже
   * подставлены, `{link}` и `{deadline}` — остаются (известны только после выставления счёта).
   */
  messageText: string;
  /** Файлы шаблона (все шаги) — вложения окна по умолчанию. */
  messageFiles: PaymentFileDto[];
  /** Сделка — для блока данных окна. */
  deal: { title: string; amount: number | null; currency: string };
  /** Контакт сделки; null — нет контакта. */
  contact: { id: number; name: string } | null;
  /** Группа требует бронь перед оплатой (настройка «Требовать бронь перед оплатой»). */
  requireBooking: boolean;
  /** Действующие брони сделки (ещё не закончились), ближайшие сверху — к какой привязать счёт. */
  bookings: PaymentBookingOption[];
  /** Бронь по умолчанию (ближайшая); null — броней нет. */
  bookingId: number | null;
  /** Брони нет, а группа её требует — сначала создать бронь. */
  bookingMissing: boolean;
  /** Брони нет, но есть уже прошедшая (последняя) — подсказать, почему её не видно. */
  pastBooking: PaymentBookingOption | null;
  /** Чего не хватает, чтобы выставить счёт (настройки, сумма, права). Пусто — можно. */
  problems: string[];
  /**
   * Нет рабочего чата с клиентом в открытой линии — окно предлагает мессенджеры, где клиент найден
   * (`CreatePaymentDto.via`), иначе ссылку отправляют сами. null — рабочий чат есть.
   */
  chatProblem?: string | null;
}

export interface PaymentBookingOption {
  bookingId: number;
  start: string;
  end: string;
  resources: string[];
}

/** `GET /api/payments/deal-options?dealId` — сделки клиента в работе, новые сверху. */
export interface PaymentDealOptionsDto {
  deals: { id: number; title: string; createdAt: string; categoryId: number | null }[];
  /** Самая новая сделка в работе; null — у клиента нет сделок в работе. */
  defaultDealId: number | null;
}

export const BOOKING_REQUIRED_MESSAGE = 'Создайте бронирование, а потом переходите к отправке оплаты';

/** `POST /api/payments` */
export interface CreatePaymentDto {
  idempotencyKey: string;
  dealId: number;
  kind: PaymentRequestKind;
  /** Своя сумма вместо рассчитанной. */
  amount?: number | null;
  bookingId?: number | null;
  /** Рабочего чата нет — ссылку отправить новым чатом с клиентом сделки (`GET /messengers/deal-targets`). */
  via?: { messengerId: string; to: string };
  /**
   * Свой текст клиенту вместо шаблона группы (одним сообщением): `{link}` / `{{СсылкаНаОплату}}` — ссылка
   * (нет ни того ни другого — ссылка последней строкой), `{deadline}` — срок оплаты.
   */
  message?: string;
  /** Вложения к своему тексту (`StoredFile`, не больше `PAYMENT_MAX_FILES`); только вместе с `message`. */
  fileIds?: string[];
}

/** Файл сообщения об оплате (`StoredFile`). */
/**
 * Файл Диска Битрикс24 в сообщении об оплате (файлы типа брони, два PDF): в списке вложений окна оплаты
 * и в заявке он значится как `disk:<ID>`; остальные вложения — ID загруженных файлов приложения.
 */
export const diskFileId = (id: number): string => `disk:${id}`;
export const parseDiskFileId = (v: string): number | null => {
  const m = /^disk:(\d{1,12})$/.exec(v);
  return m ? Number(m[1]) : null;
};

export interface PaymentFileDto {
  id: string;
  name: string;
  mime: string;
  size: number;
}

/** Вложений в сообщении со ссылкой на оплату — не больше. */
export const PAYMENT_MAX_FILES = 10;

export interface PaymentRequestDto {
  id: string;
  dealId: number;
  bookingId: number | null;
  kind: PaymentRequestKind;
  amount: number;
  invoiceId: number | null;
  /** Ссылка на оплату (для сотрудника — скопировать); в журналы не пишется. */
  link: string | null;
  status: PaymentRequestStatus;
  /** Срок оплаты (ISO); null — без срока. */
  deadline: string | null;
  messageSent: boolean;
  createdAt: string;
  createdBy: string | null;
  error: string | null;
  warnings: string[];
}

/** `GET /api/admin/invoice-meta` — справочник смарт-счетов портала для настройки группы. */
export interface InvoiceMetaDto {
  categories: { id: number; name: string; stages: { id: string; name: string }[] }[];
  /** Пользовательские поля счёта: строковые (для ссылки) и списки (постоянные значения). */
  fields: { code: string; title: string; type: string; items: { id: number; value: string }[] }[];
}

/** Черновик настроек счёта по справочнику: стадии «…предоплат…»/«…доплат…», поле «Ссылка на оплату…». */
export function suggestInvoiceConfig(meta: InvoiceMetaDto): InvoiceConfig | null {
  const cat = meta.categories[0];
  if (!cat) return null;
  const find = (re: RegExp) => cat.stages.find((s) => re.test(s.name.toLocaleLowerCase('ru')))?.id;
  const link =
    meta.fields.find((f) => f.type === 'string' && /ссылка на оплату/i.test(f.title)) ?? meta.fields.find((f) => /ссылка на оплату/i.test(f.title));
  const first = cat.stages[0]?.id ?? '';
  return {
    categoryId: cat.id,
    prepaymentStageId: find(/предоплат/) ?? first,
    surchargeStageId: find(/(^|[^е])доплат/) ?? find(/предоплат/) ?? first,
    linkField: link?.code ?? '',
    fields: {},
  };
}

/** Счёт сделки (смарт-счёт Битрикс24) — с заявкой приложения, если счёт выставило оно. */
export interface DealInvoiceDto {
  invoiceId: number;
  title: string;
  amount: number;
  currency: string;
  stageId: string;
  stageName: string;
  /** open — ждёт оплаты, paid — оплачен, failed — не оплачен / отменён. */
  state: 'open' | 'paid' | 'failed';
  createdAt: string;
  /** Выставлен приложением: ссылка, срок оплаты, статус. */
  request: PaymentRequestDto | null;
}

/** `GET /api/payments/invoices?dealId` — счета сделки, новые сверху. */
export interface DealInvoicesDto {
  dealId: number;
  invoices: DealInvoiceDto[];
}

/** Счёт «в работе» — ждёт оплаты: заявка приложения ещё идёт или счёт в Битрикс24 не закрыт. */
export function invoiceInWork(i: DealInvoiceDto): boolean {
  // Стадия в Битрикс24 важнее заявки: счёт закрыли вручную — он уже не «в работе», даже если
  // worker ещё не успел это отметить.
  if (i.state !== 'open') return false;
  if (i.request) return i.request.status === 'link_pending' || i.request.status === 'sent';
  return true;
}

/**
 * Ссылка на оплату из встройки сделки (решение владельца 2026-10-26): основание, сумма, срок до 24 ч и
 * свой текст клиенту. `{{СсылкаНаОплату}}` в тексте заменяется ссылкой.
 */
export const PAYMENT_LINK_VAR = '{{СсылкаНаОплату}}';
export const DEFAULT_PAYMENT_LINK_MESSAGE = `Просим Вам произвести оплату ${PAYMENT_LINK_VAR}`;
export const PAYMENT_MAX_TIMEOUT_HOURS = 24;

/** Текст клиенту со ссылкой: переменную — ссылкой; убрали переменную — ссылка отдельной строкой в конце. */
export function withPaymentLink(text: string, link: string): string {
  const body = text.trim();
  if (body.includes(PAYMENT_LINK_VAR)) return body.split(PAYMENT_LINK_VAR).join(link);
  return body ? `${body}\n${link}` : link;
}

/**
 * Счёт клиента во встройке сделки (решения владельца 2026-10-26 и 2026-10-31): по всем сделкам
 * контакта. Активные (`archived: false`) — счета с бронью на будущее время в любом статусе, кроме
 * «Проигран», и открытые счета, по которым ещё ждём оплату; остальные — архив (кнопка «Архив»).
 */
export interface ClientInvoiceDto {
  invoiceId: number;
  dealId: number;
  dealTitle: string;
  /** Счёт сделки, из которой открыта встройка; иначе — другая сделка клиента. */
  thisDeal: boolean;
  amount: number;
  currency: string;
  state: 'open' | 'paid' | 'failed';
  /** Статус для тега: выставлен / ждёт оплату / оплачен / проигран. */
  status: InvoiceDisplayStatus;
  /** В архив: проигран, либо бронь прошла и оплата не ожидается. */
  archived: boolean;
  createdAt: string;
  /** Основание: из заявки приложения, иначе название счёта. */
  purpose: string;
  /** Срок ссылки (ISO); null — без срока или счёт выставлен не приложением. */
  deadline: string | null;
  /** Заявка приложения; null — счёт выставлен не приложением (в просмотре — оговорка о данных). */
  requestId: string | null;
  /** Бронь счёта (заявки), иначе ближайшая действующая бронь его сделки; null — действующей брони нет. */
  booking: { bookingId: number; start: string; end: string } | null;
}

/** `GET /api/payments/client-invoices?dealId` — активные сверху (ждущие оплаты первыми), затем архив. */
export interface ClientInvoicesDto {
  dealId: number;
  invoices: ClientInvoiceDto[];
}

/** `GET /api/payments/invoice-view?dealId&invoiceId` — счёт в режиме просмотра (окно как в шаге выставления). */
export interface InvoiceViewDto {
  invoiceId: number;
  dealId: number;
  dealTitle: string;
  /** Сумма сделки; null — не прочиталась. */
  dealAmount: number | null;
  contact: { id: number; name: string } | null;
  amount: number;
  currency: string;
  stageName: string;
  state: 'open' | 'paid' | 'failed';
  status: InvoiceDisplayStatus;
  createdAt: string;
  purpose: string;
  /** Заявка приложения (статус, срок, ссылка); null — счёт выставлен не приложением. */
  request: PaymentRequestDto | null;
  /** Свой текст сообщения клиенту из заявки; null — отправлялся шаблон группы (текст не сохранён). */
  messageText: string | null;
  messageFiles: PaymentFileDto[];
  booking: PaymentBookingOption | null;
  /** Данные приложения полные (есть заявка); false — счёт старый или чужой, показываем с оговоркой. */
  complete: boolean;
}

/** Счёт, ждущий оплату (ссылка у клиента, срок идёт) — блок дашборда. */
export interface AwaitingInvoiceDto {
  requestId: string;
  invoiceId: number | null;
  dealId: number;
  dealTitle: string;
  kind: PaymentRequestKind;
  amount: number;
  /** Основание произвольной оплаты; null — предоплата/доплата. */
  purpose: string | null;
  /** Срок оплаты (ISO); null — без срока. */
  deadline: string | null;
  createdAt: string;
  createdBy: string | null;
}

/** `GET /api/payments/awaiting` — счета в ожидании оплаты: раньше истекающие сверху, без срока — в конце. */
export interface AwaitingInvoicesDto {
  invoices: AwaitingInvoiceDto[];
}
