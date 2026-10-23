import { ACTIVITY_KINDS, type ActivityEventDto, type ActivityKind, type EmployeeActivityDto } from '@btx24/shared';

export const FROM_HOUR = 9;
export const TO_HOUR = 22;
/** Сообщения с перерывом не больше этого — одна сессия работы в чатах. */
const CHAT_GAP_MS = 10 * 60_000;
/** Минимум на сессию (одно сообщение — тоже работа). */
const CHAT_MIN_MS = 2 * 60_000;

export interface Shift {
  userId: number;
  start: number;
  end: number | null;
}

/**
 * Кому приписать сообщение с телефона в момент `at` (`shifts` — записи учёта времени, у сотрудника
 * может быть несколько): тому, чья смена его покрывает; покрывают смены **нескольких** сотрудников
 * (оба включили рабочий день) — приписать одному нельзя, это совместное использование телефона;
 * никто — если смена в этот день была ровно у одного, ему; иначе никому.
 */
export function shiftOwner(shifts: Shift[], at: number, now = Date.now()): number | { shared: number[] } | null {
  const covering = [...new Set(shifts.filter((s) => s.start <= at && at <= (s.end ?? now)).map((s) => s.userId))];
  if (covering.length > 1) return { shared: covering.sort((a, b) => a - b) };
  if (covering.length) return covering[0];
  const users = new Set(shifts.map((s) => s.userId));
  return users.size === 1 ? shifts[0].userId : null;
}

/** Смена сотрудника для показа: от первого начала до последнего конца (открытая запись — «сейчас»). */
export function shiftSpan(shifts: Shift[], userId: number): { start: number; end: number | null } | null {
  const mine = shifts.filter((s) => s.userId === userId);
  if (!mine.length) return null;
  return { start: Math.min(...mine.map((s) => s.start)), end: mine.some((s) => s.end === null) ? null : Math.max(...mine.map((s) => s.end!)) };
}

/** Автосообщение приложения: то же ID, либо тот же чат, отправитель и время (±90 с). */
export interface SystemMark {
  chatId: number;
  messageId: number | null;
  userId: number | null;
  sentAt: number;
}
export function isSystemMessage(marks: SystemMark[], chatId: number, messageId: number, authorId: number, at: number): boolean {
  return marks.some((m) => (m.messageId !== null && m.messageId === messageId) || (m.messageId === null && m.chatId === chatId && (m.userId === null || m.userId === authorId) && Math.abs(m.sentAt - at) <= 90_000));
}

/** Оценка минут работы в чатах по моментам сообщений. */
export function chatMinutes(times: number[]): number {
  const t = [...times].sort((a, b) => a - b);
  let total = 0;
  let from = t[0];
  let last = t[0];
  for (let i = 1; i <= t.length; i++) {
    if (i < t.length && t[i] - last <= CHAT_GAP_MS) {
      last = t[i];
      continue;
    }
    if (from !== undefined) total += Math.max(CHAT_MIN_MS, last - from);
    from = t[i];
    last = t[i];
  }
  return Math.round(total / 60_000);
}

const empty = (): Record<ActivityKind, number> => Object.fromEntries(ACTIVITY_KINDS.map((k) => [k, 0])) as Record<ActivityKind, number>;

/** Часы дня портала, сводка и события сотрудника. */
export function summarize(
  person: Pick<EmployeeActivityDto, 'userId' | 'name' | 'shift' | 'photo' | 'sharedBy'>,
  events: ActivityEventDto[],
  timeZone: string,
): EmployeeActivityDto {
  const hourOf = (iso: string) => Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(iso)));
  const hours = Array.from({ length: TO_HOUR - FROM_HOUR }, empty);
  const totals = empty();
  for (const e of events) {
    totals[e.kind]++;
    const h = hourOf(e.at);
    if (h >= FROM_HOUR && h < TO_HOUR) hours[h - FROM_HOUR][e.kind]++;
  }
  const sorted = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return {
    ...person,
    hours,
    totals,
    callMinutes: Math.round(events.filter((e) => e.kind === 'call').reduce((s, e) => s + (e.durationSec ?? 0), 0) / 60),
    chatMinutes: chatMinutes(events.filter((e) => e.kind === 'chat' || e.kind === 'phone').map((e) => Date.parse(e.at))),
    events: sorted,
  };
}
