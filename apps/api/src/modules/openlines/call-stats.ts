import type { CallKind } from '@btx24/shared';

/** Звонок из дел CRM (`crm.activity.list`, PROVIDER_ID = VOXIMPLANT_CALL). */
export interface CallActivity {
  ID: string;
  OWNER_ID: string;
  OWNER_TYPE_ID: string;
  /** 1 — входящий, 2 — исходящий. */
  DIRECTION: string;
  START_TIME: string;
  RESPONSIBLE_ID: string;
  SETTINGS?: { MISSED_CALL?: boolean } | unknown[];
  COMMUNICATIONS?: { VALUE?: string }[];
}

export const isMissed = (c: CallActivity) =>
  !Array.isArray(c.SETTINGS) && (c.SETTINGS as { MISSED_CALL?: boolean } | undefined)?.MISSED_CALL === true;
const incoming = (c: CallActivity) => String(c.DIRECTION) === '1';

/** Клиент звонка: последние 10 цифр номера, без номера — элемент CRM. */
export function clientKey(c: CallActivity): string {
  const digits = String(c.COMMUNICATIONS?.[0]?.VALUE ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : `crm:${c.OWNER_TYPE_ID}:${c.OWNER_ID}`;
}

/**
 * Звонки периода по видам. `calls` — все звонки с начала периода по сейчас (перезвон мог быть
 * позже периода и другим сотрудником). Учитываются входящие периода, при `responsibleId` — свои.
 * - пропущенный — входящий с признаком `MISSED_CALL`; отвеченный — входящий без него;
 * - упущенный — клиент (по номеру), чей последний пропущенный входящий в периоде не сменился
 *   позже ни отвеченным входящим, ни исходящим ему. Один клиент — один упущенный.
 * Ограничение: «не дозвонились» на исходящем по делам CRM не видно (нужна статистика телефонии,
 * право `telephony`) — любой исходящий после пропущенного считается попыткой перезвонить.
 */
export function classifyCalls(
  calls: CallActivity[],
  start: Date,
  end: Date,
  responsibleId: number | null,
): Record<CallKind, CallActivity[]> {
  const t = (c: CallActivity) => Date.parse(c.START_TIME);
  const inPeriod = calls.filter(
    (c) =>
      incoming(c) &&
      t(c) >= start.getTime() &&
      t(c) < end.getTime() &&
      (responsibleId === null || Number(c.RESPONSIBLE_ID) === responsibleId),
  );
  const missed = inPeriod.filter(isMissed);
  // Последний пропущенный каждого клиента.
  const lastMissed = new Map<string, CallActivity>();
  for (const c of missed) {
    const k = clientKey(c);
    const prev = lastMissed.get(k);
    if (!prev || t(c) > t(prev)) lastMissed.set(k, c);
  }
  const contacted = (m: CallActivity) =>
    calls.some((c) => clientKey(c) === clientKey(m) && t(c) > t(m) && (!incoming(c) || !isMissed(c)));
  const byTime = (a: CallActivity, b: CallActivity) => t(b) - t(a);
  return {
    incoming: [...inPeriod].sort(byTime),
    answered: inPeriod.filter((c) => !isMissed(c)).sort(byTime),
    missed: [...missed].sort(byTime),
    lost: [...lastMissed.values()].filter((m) => !contacted(m)).sort(byTime),
  };
}
