// Статус сделки для дашбордов и звонков (решение владельца 2026-10-23): по канбану (семантика стадии)
// и броням сделки. «В работе» делится на «В работе», «Ожидание клиента» (активная бронь впереди) и
// «Клиент приехал» (бронь идёт прямо сейчас).

export const DEAL_STATUSES = ['in_work', 'waiting', 'arrived', 'done', 'failed'] as const;
export type DealStatus = (typeof DEAL_STATUSES)[number];

export const DEAL_STATUS_LABELS: Record<DealStatus, string> = {
  in_work: 'В работе',
  waiting: 'Ожидание клиента',
  arrived: 'Клиент приехал',
  done: 'Завершена',
  failed: 'Провалена',
};

export interface DealStatusDto {
  status: DealStatus;
  /** Бронь прошла, а сделка в канбане ещё в работе — считается завершённой, закрыть в Битрикс24. */
  needsClose: boolean;
  /** Бронь, по которой решён статус (ближайшая активная или последняя прошедшая); null — брони нет. */
  bookingEnd: string | null;
}

export const NEEDS_CLOSE_TEXT = 'Бронь прошла — закройте сделку в Битрикс24';

export interface DealStatusInput {
  /** `STAGE_SEMANTIC_ID`: P — в работе, S — успех, F — провал. */
  stageSemantic: string | null | undefined;
  /**
   * Брони сделки из журнала приложения (без удалённых в Битрикс24, ждущих решения). null — журнал о
   * сделке не знает (бронь вне горизонта сверки или старая) — тогда решает поле даты брони сделки.
   */
  bookings: { start: string; end: string }[] | null;
  /** Поле сделки «конец брони» (запасной источник). */
  fieldEnd?: string | null;
}

export function dealStatus(input: DealStatusInput, now: number = Date.now()): DealStatusDto {
  if (input.stageSemantic === 'F') return { status: 'failed', needsClose: false, bookingEnd: null };
  if (input.stageSemantic === 'S') return { status: 'done', needsClose: false, bookingEnd: null };
  // Бронь идёт сейчас — клиент на месте.
  const current = (input.bookings ?? []).find((b) => Date.parse(b.start) <= now && Date.parse(b.end) > now);
  if (current) return { status: 'arrived', needsClose: false, bookingEnd: new Date(Date.parse(current.end)).toISOString() };
  const ends = (input.bookings ?? []).map((b) => Date.parse(b.end)).filter(Number.isFinite);
  if (input.bookings === null) {
    const f = Date.parse(String(input.fieldEnd ?? ''));
    if (Number.isFinite(f)) ends.push(f);
  }
  const upcoming = ends.filter((t) => t > now).sort((a, b) => a - b);
  if (upcoming.length) return { status: 'waiting', needsClose: false, bookingEnd: new Date(upcoming[0]).toISOString() };
  if (ends.length) return { status: 'done', needsClose: true, bookingEnd: new Date(Math.max(...ends)).toISOString() };
  return { status: 'in_work', needsClose: false, bookingEnd: null };
}

/**
 * Цвет сделки при выборе для новой брони (решение владельца 2026-10-23): `booked` — у сделки есть бронь
 * (идёт или впереди) — красный; `filled` — брони нет, но служебные поля брони в сделке ещё заполнены —
 * оранжевый; `empty` — пустая сделка — зелёный.
 */
export type DealBookingTone = 'booked' | 'filled' | 'empty';
export const DEAL_TONE_LABELS: Record<DealBookingTone, string> = {
  booked: 'есть бронь',
  filled: 'брони нет, но заполнены поля брони',
  empty: 'пустая сделка',
};
