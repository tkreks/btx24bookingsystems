// Счёт и ссылка на оплату (ADR 0009): приложение создаёт смарт-счёт сделки, ссылку на оплату в
// поле счёта ставит робот портала (платёжная система), приложение отправляет её клиенту и
// следит за оплатой до срока.

export const PAYMENT_KINDS = ['prepayment', 'surcharge'] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];
export const PAYMENT_KIND_LABELS: Record<PaymentKind, string> = { prepayment: 'Предоплата', surcharge: 'Доплата' };

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
export type PaymentAmountSource = 'fixed' | 'manual' | 'percent' | 'none';

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
  kind: PaymentKind;
  groupId: string | null;
  groupName: string | null;
  amount: number | null;
  source: PaymentAmountSource;
  /** Минут на оплату (только предоплата); null — без срока. */
  timeoutMinutes: number | null;
  /** Текст клиенту (ссылка — `{link}`, подставится после создания счёта). */
  message: string;
  /** Чего не хватает, чтобы выставить счёт (настройки, сумма, права). Пусто — можно. */
  problems: string[];
}

/** `POST /api/payments` */
export interface CreatePaymentDto {
  idempotencyKey: string;
  dealId: number;
  kind: PaymentKind;
  /** Своя сумма вместо рассчитанной. */
  amount?: number | null;
  bookingId?: number | null;
}

export interface PaymentRequestDto {
  id: string;
  dealId: number;
  bookingId: number | null;
  kind: PaymentKind;
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
