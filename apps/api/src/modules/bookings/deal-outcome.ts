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

/** Поля сделки, по которым решается «состоялась»: дата конца брони и признаки покупки сертификата. */
export interface DealOutcomeFields {
  bookingEnd?: string;
  dealType?: string;
  paidAmount?: string;
  /** Номер варианта «Покупка сертификата» в поле `dealType`; null — нет такого варианта. */
  certificateTypeId: string | null;
}

/** Что выбрать в `crm.deal.list`, чтобы посчитать `happened`. */
export function outcomeSelect(o: DealOutcomeFields): string[] {
  return [o.bookingEnd, o.certificateTypeId ? o.dealType : undefined, o.certificateTypeId ? o.paidAmount : undefined].filter((x): x is string => !!x);
}

/** Покупка сертификата (поле «Тип сделки»). */
export function isCertificatePurchase(d: Record<string, unknown>, o: DealOutcomeFields): boolean {
  return !!(o.certificateTypeId && o.dealType && String(d[o.dealType] ?? '') === o.certificateTypeId);
}

/** «Сумма внесённых оплат»: «100000|RUB» или число. */
export function paidSum(v: unknown): number {
  const n = Number(String(v ?? '').split('|')[0]);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Сделка состоялась: покупка сертификата — не проиграна и оплачена (есть внесённые оплаты или
 * выиграна); иначе — `dealHappened` по брони.
 */
export function happened(d: Record<string, string | null | undefined>, o: DealOutcomeFields, before: number): boolean {
  if (isCertificatePurchase(d, o)) {
    if (d.STAGE_SEMANTIC_ID === 'F') return false;
    return d.STAGE_SEMANTIC_ID === 'S' || (!!o.paidAmount && paidSum(d[o.paidAmount]) > 0);
  }
  return dealHappened(d, o.bookingEnd ? d[o.bookingEnd] : null, before);
}
