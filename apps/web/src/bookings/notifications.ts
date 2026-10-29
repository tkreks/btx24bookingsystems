import { alertType, type BookingAlertDto, type ContactAlertDto, type ContactChangeDto } from '@btx24/shared';

/** Критичность уведомления: серый — не критично, оранжевый — обратите внимание, красный — проверить! */
export type Severity = 'info' | 'warning' | 'critical';

export const SEVERITY_LABELS: Record<Severity, string> = { info: 'Не критично', warning: 'Обратите внимание', critical: 'Проверить!' };

/** Поля контакта, изменение которых важно для связи с клиентом. */
const IMPORTANT = /^(NAME|LAST_NAME|SECOND_NAME|PHONE|EMAIL|IM)$|TELEGRAM|WHATSAPP|MAX/i;

/** Изменённых полей в строке уведомления — остальные под «Показать ещё». */
export const CHANGES_SHOWN = 5;

/** Значение поля для людей: множественные поля — значения через запятую, пусто — «—». */
export function fieldValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) {
    const parts = v.map((x) => (x && typeof x === 'object' && 'VALUE' in x ? String((x as { VALUE: unknown }).VALUE ?? '') : fieldValue(x))).filter((x) => x && x !== '—');
    return parts.length ? parts.join(', ') : '—';
  }
  if (typeof v === 'object') {
    const text = JSON.stringify(v);
    return text.length > 80 ? `${text.slice(0, 79)}…` : text;
  }
  if (v === 'Y') return 'да';
  if (v === 'N') return 'нет';
  return String(v);
}

/** Только поля, где значение для людей действительно поменялось. */
export function realChanges(changes: ContactChangeDto[]): ContactChangeDto[] {
  return changes.filter((c) => fieldValue(c.before) !== fieldValue(c.after));
}

export function contactSeverity(a: Pick<ContactAlertDto, 'kind' | 'changes'>): Severity {
  if (a.kind === 'deleted') return 'critical';
  if (a.kind === 'missing') return 'warning';
  return realChanges(a.changes).some((c) => IMPORTANT.test(c.field)) ? 'warning' : 'info';
}

export function bookingSeverity(a: BookingAlertDto): Severity {
  const t = alertType(a);
  return t === 'removal' || t === 'not_cancelled' ? 'critical' : t === 'change' ? 'warning' : 'info';
}

/** «Принять все изменения»: брони — только изменения и новые (удаления — красные, их проверяют по одной). */
export function bulkAcceptable(a: BookingAlertDto): boolean {
  const t = alertType(a);
  return (a.status === 'new' || a.status === 'viewed') && (t === 'change' || t === 'new_booking');
}

export type TimelineItem = { kind: 'booking'; at: string; a: BookingAlertDto } | { kind: 'contact'; at: string; a: ContactAlertDto };

/** Одна лента: новые сверху. */
export function mergeTimeline(bookings: BookingAlertDto[], contacts: ContactAlertDto[]): TimelineItem[] {
  return [
    ...bookings.map((a): TimelineItem => ({ kind: 'booking', at: a.createdAt, a })),
    ...contacts.map((a): TimelineItem => ({ kind: 'contact', at: a.createdAt, a })),
  ].sort((x, y) => y.at.localeCompare(x.at));
}
