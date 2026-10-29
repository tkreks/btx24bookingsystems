/**
 * Внешний просмотр (вход по логину и паролю, роль `viewer`): экран «Бронирования» на день — список,
 * календарь и доступность ресурсов. Данные — из базы приложения, права — настройки внешнего пользователя.
 */

export interface ExternalLoginDto {
  login: string;
  password: string;
  /** Адрес портала — только если приложение стоит на нескольких. */
  domain?: string;
}

export interface ViewerSessionDto {
  login: string;
  role: 'viewer';
  portal: { domain: string; timezone: string };
  groups: { id: string; name: string }[];
}

export interface ViewerBookingDto {
  bookingId: number;
  title: string;
  startsAt: string;
  endsAt: string;
  resourceIds: number[];
  dealId: number | null;
  /** null — поле скрыто правами или не заполнено (не путать с нулём). */
  clientName: string | null;
  guests: number | null;
  programGuests: number | null;
  /** Сумма сделки; null — неизвестна или скрыта. */
  amount: number | null;
  /** Оплачено; null — нет данных или скрыто. */
  paid: number | null;
  currency: string;
  lastPaymentAt: string | null;
  /** Сумма последней оплаты (рост «Суммы внесённых оплат»). */
  lastPaymentAmount: number | null;
  /** Оплаты сделки (оплаченные счета, без счетов — замеченный рост оплат), новые сверху. */
  payments: { at: string; amount: number }[];
  comment: string | null;
  important: string | null;
  /** Товары сделки можно запросить (`/external/bookings/:id/products`). */
  products: boolean;
}

export interface ViewerTechWindowDto {
  resourceId: number;
  startsAt: string;
  endsAt: string;
}

export interface ViewerDayDto {
  date: string;
  timezone: string;
  /** '' — все доступные группы. */
  groupId: string;
  resources: { id: number; name: string }[];
  bookings: ViewerBookingDto[];
  techWindows: ViewerTechWindowDto[];
  /** Последняя сверка броней с Битрикс24. */
  syncedAt: string | null;
}

export interface ViewerProductDto {
  name: string;
  price: number;
  quantity: number;
  sum: number;
}

export interface ViewerProductsDto {
  items: ViewerProductDto[];
}

export type PayStatus = 'unpaid' | 'partial' | 'paid' | 'overpaid' | 'unknown';

export const PAY_STATE_LABELS: Record<PayStatus, string> = {
  unpaid: 'Не оплачено',
  partial: 'Частично оплачено',
  paid: 'Оплачено полностью',
  overpaid: 'Переплата',
  unknown: 'Нет данных',
};

export interface PaymentState {
  status: PayStatus;
  /** null — сумма или оплата неизвестны (не показываем как ноль). */
  percent: number | null;
  debt: number | null;
  overpay: number | null;
}

/** Статус оплаты по сумме сделки и оплаченному. Неизвестное не превращается в ноль. */
export function paymentState(amount: number | null, paid: number | null): PaymentState {
  if (amount === null || paid === null) return { status: 'unknown', percent: null, debt: null, overpay: null };
  if (amount <= 0) return { status: paid > 0 ? 'overpaid' : 'unknown', percent: null, debt: null, overpay: paid > 0 ? paid : null };
  const percent = Math.floor((paid / amount) * 100);
  if (paid > amount) return { status: 'overpaid', percent, debt: 0, overpay: paid - amount };
  if (paid === amount) return { status: 'paid', percent: 100, debt: 0, overpay: null };
  return { status: paid > 0 ? 'partial' : 'unpaid', percent, debt: amount - paid, overpay: null };
}

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10;
  const m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};

/** «3 часа 30 минут», «45 минут», «1 сутки 2 часа». */
export function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d} ${plural(d, 'сутки', 'суток', 'суток')}`);
  if (h) parts.push(`${h} ${plural(h, 'час', 'часа', 'часов')}`);
  if (m || !parts.length) parts.push(`${m} ${plural(m, 'минута', 'минуты', 'минут')}`);
  return parts.join(' ');
}

export interface TimeSpan {
  start: number;
  end: number;
}

/** Занятые отрезки внутри [from, to): обрезанные, слитые, по порядку. */
export function mergeSpans(spans: TimeSpan[], from: number, to: number): TimeSpan[] {
  const cut = spans
    .map((s) => ({ start: Math.max(s.start, from), end: Math.min(s.end, to) }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
  const out: TimeSpan[] = [];
  for (const s of cut) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

/** Свободные окна [from, to) между занятыми отрезками. */
export function freeSpans(busy: TimeSpan[], from: number, to: number): TimeSpan[] {
  const out: TimeSpan[] = [];
  let at = from;
  for (const b of mergeSpans(busy, from, to)) {
    if (b.start > at) out.push({ start: at, end: b.start });
    at = Math.max(at, b.end);
  }
  if (at < to) out.push({ start: at, end: to });
  return out;
}
