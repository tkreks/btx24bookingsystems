import { todayIn, zonedTimeToUtc } from './time.js';

/**
 * Автоматическая рассылка группы (`GroupOptionsDto.autoMessages`): за `hoursBefore` часов до начала
 * клиентской брони — системный шаблон (назначение `auto`) в чат сделки, но только в рабочее окно
 * `[windowFrom, windowTo)` по времени портала (пример владельца 2026-10-23: за сутки, 9:00–22:00,
 * «Просим подтвердить бронирование»).
 */
export interface AutoMessageRule {
  id: string;
  enabled: boolean;
  name: string;
  /** Пока один вид: до начала брони. */
  trigger: 'before_start';
  hoursBefore: number;
  /** «09:00»–«22:00», время портала. */
  windowFrom: string;
  windowTo: string;
  templateId: string;
}

/** Последняя минута окна, когда ещё отправляем, — запас на интервал прохода worker'а. */
export const AUTO_WINDOW_MARGIN_MIN = 10;

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const localMinutes = (at: number, tz: string) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at)).map((x) => [x.type, x.value]),
  );
  return Number(p.hour) * 60 + Number(p.minute);
};

/** Сейчас — внутри окна отправки (по времени портала). */
export function inSendWindow(at: number, rule: Pick<AutoMessageRule, 'windowFrom' | 'windowTo'>, tz: string): boolean {
  const m = localMinutes(at, tz);
  return m >= minutes(rule.windowFrom) && m < minutes(rule.windowTo);
}

/**
 * Когда отправить: срок «за N часов до начала»; он вне окна — в окно того же дня (раньше 9:00 — в
 * 9:00, позже 22:00 — за `AUTO_WINDOW_MARGIN_MIN` до конца окна). null — к началу брони не успеть.
 */
export function autoSendAt(startsAt: number, rule: Pick<AutoMessageRule, 'hoursBefore' | 'windowFrom' | 'windowTo'>, tz: string): number | null {
  const due = startsAt - rule.hoursBefore * 3600_000;
  const day = todayIn(tz, new Date(due));
  const from = zonedTimeToUtc(day, rule.windowFrom, tz).getTime();
  const lastMinute = zonedTimeToUtc(day, rule.windowTo, tz).getTime() - AUTO_WINDOW_MARGIN_MIN * 60_000;
  const at = due < from ? from : due > lastMinute ? lastMinute : due;
  return at < startsAt ? at : null;
}
