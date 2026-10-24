/** Не больше десяти категорий; автор/источник и критичность — независимые признаки. */
export const ACTION_LOG_CATEGORIES = ['security', 'settings', 'bookings', 'crm', 'payments', 'communications', 'resources', 'integration', 'errors', 'other'] as const;
export type ActionLogCategory = typeof ACTION_LOG_CATEGORIES[number];
export const ACTION_LOG_CATEGORY_LABELS: Record<ActionLogCategory, string> = {
  security: 'Безопасность', settings: 'Настройки', bookings: 'Бронирования', crm: 'Сделки и клиенты',
  payments: 'Оплаты и сертификаты', communications: 'Сообщения и чаты', resources: 'Ресурсы',
  integration: 'Интеграция', errors: 'Ошибки', other: 'Прочее',
};
export const ACTION_LOG_SEVERITIES = ['info', 'warning', 'high', 'critical'] as const;
export type ActionLogSeverity = typeof ACTION_LOG_SEVERITIES[number];
export const ACTION_LOG_SEVERITY_LABELS: Record<ActionLogSeverity, string> = { info: 'Низкая', warning: 'Средняя', high: 'Высокая', critical: 'Критическая' };

const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const SECURITY_FIELDS = new Set(['members', 'admins', 'appUsers', 'heads', 'permissions', 'role', 'roles', 'rolePermissions', 'resourceIds', 'features']);

/** Единое правило для новых и старых неизменяемых записей. Не зависит от языка описания. */
export function classifyActionLog(entry: { action: string; entityType?: string | null; details?: unknown }): { category: ActionLogCategory; severity: ActionLogSeverity } {
  const d = object(entry.details);
  const nested = object(d.details);
  const route = typeof d.route === 'string' ? d.route : '';
  const changes = Array.isArray(d.changes) ? d.changes : [];
  const changedAccess = changes.some((c) => SECURITY_FIELDS.has(String(object(c).field)));
  const action = entry.action;
  const failed = action === 'bitrix.error' || action === 'app.error' || action.endsWith('.failed') || action.endsWith('.compensation_failed') || (action === 'request' && !!d.error);
  if (failed) {
    const status = Number(d.httpStatus);
    const code = String(d.code ?? '');
    return { category: 'errors', severity: action.endsWith('.compensation_failed') ? 'critical' : [400, 401, 403, 404, 409, 422, 429].includes(status) || ['QUERY_LIMIT_EXCEEDED', 'expired_token', 'ACCESS_DENIED', 'ERROR_ACCESS_DENIED'].includes(code) ? 'warning' : 'high' };
  }
  if (action === 'app.enter' || action === 'app.login') return { category: 'security', severity: 'info' };
  if (route.endsWith('/logout')) return { category: 'security', severity: 'info' };
  if (action === 'app.denied') return { category: 'security', severity: 'warning' };
  if (action === 'group.archive' || action === 'chat_folder.global' || ((action === 'group.update' || action === 'settings.update') && changedAccess) || /(?:settings-access|settings-codes|external-users|\/auth\/|\/logout)/.test(route)) return { category: 'security', severity: 'high' };
  if (action === 'group.create' && Array.isArray(object(d.after).members) && (object(d.after).members as unknown[]).length) return { category: 'security', severity: 'high' };
  if (/^(settings\.|group\.|dashboard\.layout)/.test(action) || /\/(?:admin\/settings|admin\/groups|dashboard\/layout|openlines\/templates)/.test(route)) return { category: 'settings', severity: action === 'group.archive' || route.startsWith('DELETE ') ? 'warning' : 'info' };
  if (/^(payment\.|certificate\.)/.test(action) || ['booking.paid', 'booking.payment_cancelled'].includes(action) || /\/(?:payments|certificates)(?:\/|$)/.test(route)) return { category: 'payments', severity: ['payment.link_not_sent', 'payment.expired', 'payment.cancelled_in_bitrix', 'booking.payment_cancelled', 'certificate.redeemed'].includes(action) || (Array.isArray(d.warnings) && d.warnings.length > 0) ? 'warning' : 'info' };
  if (/^resource\./.test(action) || /\/(?:resource-stops|admin\/resources)(?:\/|$)/.test(route)) return { category: 'resources', severity: action === 'resource.stop' || route.startsWith('DELETE ') ? 'warning' : 'info' };
  if (/^booking\./.test(action) || /\/(?:bookings|booking-alerts)(?:\/|$)/.test(route)) return { category: 'bookings', severity: ['booking.cancelled', 'booking.discrepancy_found', 'booking.deleted_in_bitrix', 'booking.recreated_in_bitrix', 'booking.rolled_back'].includes(action) || nested.reason === 'payment_timeout' ? 'warning' : 'info' };
  if (/^deal\./.test(action) || /\/(?:deals|crm)(?:\/|$)/.test(route)) return { category: 'crm', severity: 'info' };
  if (/^(chat\.|chat_folder\.)/.test(action) || /\/(?:openlines|dashboard\/hidden-chats)(?:\/|$)/.test(route)) return { category: 'communications', severity: 'info' };
  if (/^(placements\.|bitrix\.)/.test(action) || /\/admin\/(?:placements|booking-sync)(?:\/|$)/.test(route)) return { category: 'integration', severity: 'info' };
  return { category: 'other', severity: 'info' };
}
