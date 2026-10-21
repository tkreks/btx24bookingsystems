import {
  ALERT_PROBLEM_LABELS,
  ALERT_STATUS_LABELS,
  type AlertProblem,
  type AlertStatus,
  type BookingStateDto,
} from '@btx24/shared';

/** Сообщение уведомления в чат Битрикс24: суть, «было/стало», статус и кнопки действий. */
export interface AlertMessageInput {
  kind: 'new_booking' | 'discrepancy';
  problems: AlertProblem[];
  bookingId: number;
  dealId: number | null;
  title: string | null;
  expected: BookingStateDto | null;
  actual: BookingStateDto | null;
  status: AlertStatus;
  /** «Иван Петров, 21.10 21:30» — кто и когда сменил статус. */
  statusBy: string | null;
  resources: Map<number, string>;
  timeZone: string;
  /** Ссылка на приложение в портале (относительная), куда ведут «Изменить» и «Отменить». */
  appPath: string | null;
  alertId: string;
}

const STATUS_ICON: Record<AlertStatus, string> = { new: '🆕', viewed: '👁', resolved: '✅', ignored: '🚫' };

export function alertMessage(a: AlertMessageInput): { MESSAGE: string; KEYBOARD: unknown[] } {
  const when = (s: BookingStateDto) => period(s, a.timeZone);
  const res = (s: BookingStateDto) => s.resourceIds.map((id) => a.resources.get(id) ?? `Ресурс ${id}`).join(', ') || '—';
  const deal = (s: BookingStateDto) => (s.dealId ? `сделка #${s.dealId}` : 'без сделки');
  const lines: string[] = [];
  if (a.kind === 'new_booking') {
    lines.push('[b]Найдено новое бронирование[/b] — создано не через приложение.');
    if (a.actual) lines.push(`Бронь #${a.bookingId}${a.title ? ` «${a.title}»` : ''}: ${when(a.actual)}, ${res(a.actual)}, ${deal(a.actual)}.`);
  } else {
    lines.push(`[b]Внимание: зафиксировано расхождение данных[/b] по брони #${a.bookingId}. Как поступить?`);
    lines.push(`Что не совпало: ${a.problems.map((p) => ALERT_PROBLEM_LABELS[p]).join('; ')}.`);
    if (a.expected) lines.push(`В приложении: ${when(a.expected)}, ${res(a.expected)}, ${deal(a.expected)}.`);
    lines.push(a.actual ? `В Битрикс24: ${when(a.actual)}, ${res(a.actual)}, ${deal(a.actual)}.` : 'В Битрикс24: брони нет.');
  }
  lines.push(`Статус: ${STATUS_ICON[a.status]} [b]${ALERT_STATUS_LABELS[a.status]}[/b]${a.statusBy ? ` — ${a.statusBy}` : ''}`);

  const keyboard: unknown[] = [];
  const dealId = a.actual?.dealId ?? a.expected?.dealId ?? a.dealId;
  if (dealId) keyboard.push({ TEXT: 'Открыть сделку', LINK: `/crm/deal/details/${dealId}/`, BG_COLOR_TOKEN: 'primary', DISPLAY: 'LINE' });
  if (a.appPath) {
    const link = `${a.appPath}?alert=${encodeURIComponent(a.alertId)}`;
    keyboard.push({ TEXT: 'Изменить бронь', LINK: link, DISPLAY: 'LINE' });
    keyboard.push({ TEXT: 'Отменить бронь', LINK: link, BG_COLOR_TOKEN: 'alert', DISPLAY: 'LINE' });
  }
  return { MESSAGE: lines.join('\n'), KEYBOARD: keyboard };
}

/** «23.10 14:00–16:00» или «23.10 14:00 – 25.10 12:00» в поясе портала. */
export function period(s: BookingStateDto, timeZone: string): string {
  const d = (iso: string) =>
    new Intl.DateTimeFormat('ru-RU', { timeZone, day: '2-digit', month: '2-digit' }).format(new Date(iso));
  const t = (iso: string) =>
    new Intl.DateTimeFormat('ru-RU', { timeZone, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  return d(s.startsAt) === d(s.endsAt)
    ? `${d(s.startsAt)} ${t(s.startsAt)}–${t(s.endsAt)}`
    : `${d(s.startsAt)} ${t(s.startsAt)} – ${d(s.endsAt)} ${t(s.endsAt)}`;
}

/** Что не совпало между ожидаемым и фактическим состоянием брони. */
export function diffState(expected: BookingStateDto, actual: BookingStateDto): AlertProblem[] {
  const out: AlertProblem[] = [];
  if (Date.parse(expected.startsAt) !== Date.parse(actual.startsAt) || Date.parse(expected.endsAt) !== Date.parse(actual.endsAt))
    out.push('time');
  const a = [...expected.resourceIds].sort((x, y) => x - y).join(',');
  const b = [...actual.resourceIds].sort((x, y) => x - y).join(',');
  if (a !== b) out.push('resources');
  if ((expected.dealId ?? null) !== (actual.dealId ?? null)) out.push('deal');
  return out;
}
