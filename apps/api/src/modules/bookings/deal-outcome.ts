/**
 * Сделка «состоялась» (клиент был): не проиграна и её бронь уже закончилась — по факту большинство
 * прошедших броней не переводят в «успешно» (уточнение владельца 2026-10-21). Без даты брони —
 * только выигранная (`STAGE_SEMANTIC_ID = S`), закрытая до момента `before`.
 */
export function dealHappened(
  d: { STAGE_SEMANTIC_ID?: string | null; CLOSEDATE?: string | null },
  bookingEnd: string | null | undefined,
  before: number,
): boolean {
  if (d.STAGE_SEMANTIC_ID === 'F') return false;
  const end = bookingEnd ? Date.parse(bookingEnd) : NaN;
  if (Number.isFinite(end)) return end < before;
  return d.STAGE_SEMANTIC_ID === 'S' && (!d.CLOSEDATE || Date.parse(d.CLOSEDATE) < before);
}
