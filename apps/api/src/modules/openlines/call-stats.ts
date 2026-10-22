/** Звонок из дел CRM (`crm.activity.list`, PROVIDER_ID = VOXIMPLANT_CALL). */
export interface CallActivity {
  ID: string;
  OWNER_ID: string;
  OWNER_TYPE_ID: string;
  /** 1 — входящий, 2 — исходящий. */
  DIRECTION: string;
  START_TIME: string;
  /** Конец разговора: у неотвеченного звонка совпадает с началом. */
  END_TIME?: string;
  RESPONSIBLE_ID: string;
  SETTINGS?: { MISSED_CALL?: boolean } | unknown[];
  COMMUNICATIONS?: { VALUE?: string; ENTITY_TYPE_ID?: string | number; ENTITY_ID?: string | number }[];
}

export const isMissed = (c: CallActivity) =>
  !Array.isArray(c.SETTINGS) && (c.SETTINGS as { MISSED_CALL?: boolean } | undefined)?.MISSED_CALL === true;
const incoming = (c: CallActivity) => String(c.DIRECTION) === '1';

/** Длительность разговора, секунд (по делу CRM: конец − начало). */
export function callDurationSec(c: CallActivity): number {
  const d = (Date.parse(c.END_TIME ?? '') - Date.parse(c.START_TIME)) / 1000;
  return Number.isFinite(d) && d > 0 ? Math.round(d) : 0;
}

/**
 * Статус для журнала: входящий — пропущен по признаку телефонии (как на плитках дашборда);
 * исходящий без разговора (длительность 0) — «нет ответа». Без права `telephony` точнее не узнать.
 */
export function callStatus(c: CallActivity): 'success' | 'missed' | 'no_answer' {
  if (incoming(c)) return isMissed(c) ? 'missed' : 'success';
  return callDurationSec(c) === 0 ? 'no_answer' : 'success';
}
const t = (c: CallActivity) => Date.parse(c.START_TIME);

/** Контакт звонка (CRM, тип 3) — если есть. */
export function contactOf(c: CallActivity): number | null {
  const m = c.COMMUNICATIONS?.find((x) => Number(x.ENTITY_TYPE_ID) === 3 && Number(x.ENTITY_ID) > 0);
  return m ? Number(m.ENTITY_ID) : null;
}

/**
 * Клиент звонка: контакт CRM; без контакта — последние 10 цифр номера; без номера — элемент
 * CRM, к которому привязан звонок. Звонки с одного номера и на него — один клиент.
 */
export function clientKey(c: CallActivity): string {
  const contact = contactOf(c);
  if (contact) return `contact:${contact}`;
  const digits = String(c.COMMUNICATIONS?.[0]?.VALUE ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? `phone:${digits.slice(-10)}` : `crm:${c.OWNER_TYPE_ID}:${c.OWNER_ID}`;
}

/** Клиент периода: его входящие и признаки. */
export interface CallClient {
  key: string;
  contactId: number | null;
  /** Входящие периода, новые сверху. */
  incoming: CallActivity[];
  firstIncomingAt: number;
  answered: boolean;
  missed: boolean;
  /** Последний пропущенный не сменился ни отвеченным входящим, ни исходящим (после него). */
  lost: boolean;
}

/**
 * Клиенты, звонившие в периоде (входящие; при `responsibleId` — свои). `calls` — все звонки с
 * начала периода по сейчас: перезвон мог быть позже периода и другим сотрудником.
 * Ограничение: «не дозвонились» на исходящем по делам CRM не видно (нужна статистика телефонии,
 * право `telephony`) — любой исходящий после пропущенного считается попыткой перезвонить.
 */
export function callClients(calls: CallActivity[], start: Date, end: Date, responsibleId: number | null): CallClient[] {
  const byKey = new Map<string, CallClient>();
  for (const c of calls) {
    if (!incoming(c) || t(c) < start.getTime() || t(c) >= end.getTime()) continue;
    if (responsibleId !== null && Number(c.RESPONSIBLE_ID) !== responsibleId) continue;
    const key = clientKey(c);
    const cl = byKey.get(key) ?? {
      key,
      contactId: contactOf(c),
      incoming: [],
      firstIncomingAt: t(c),
      answered: false,
      missed: false,
      lost: false,
    };
    cl.incoming.push(c);
    cl.firstIncomingAt = Math.min(cl.firstIncomingAt, t(c));
    if (isMissed(c)) cl.missed = true;
    else cl.answered = true;
    byKey.set(key, cl);
  }
  const all = [...calls];
  for (const cl of byKey.values()) {
    cl.incoming.sort((a, b) => t(b) - t(a));
    const lastMissed = cl.incoming.find(isMissed);
    cl.lost =
      !!lastMissed &&
      !all.some((c) => clientKey(c) === cl.key && t(c) > t(lastMissed) && (!incoming(c) || !isMissed(c)));
  }
  return [...byKey.values()].sort((a, b) => t(b.incoming[0]) - t(a.incoming[0]));
}
