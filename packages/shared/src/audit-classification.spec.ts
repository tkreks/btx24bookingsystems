import { describe, expect, it } from 'vitest';
import { ACTION_LOG_CATEGORIES, classifyActionLog } from './audit-classification.js';

describe('классификация всех источников журнала', () => {
  it('не больше десяти категорий', () => expect(ACTION_LOG_CATEGORIES.length).toBeLessThanOrEqual(10));
  it.each([
    ['app.enter', 'security', 'info'], ['app.login', 'security', 'info'], ['app.denied', 'security', 'warning'],
    ['app.error', 'errors', 'high'], ['bitrix.error', 'errors', 'high'], ['booking.compensation_failed', 'errors', 'critical'],
    ['group.create', 'settings', 'info'], ['group.update', 'settings', 'info'], ['group.reorder', 'settings', 'info'], ['group.archive', 'security', 'high'],
    ['settings.update', 'settings', 'info'], ['dashboard.layout', 'settings', 'info'], ['placements.sync', 'integration', 'info'],
    ['booking.created', 'bookings', 'info'], ['booking.cancelled', 'bookings', 'warning'], ['booking.imported', 'bookings', 'info'],
    ['booking.changed_in_bitrix', 'bookings', 'info'], ['booking.discrepancy_found', 'bookings', 'warning'],
    ['booking.deleted_in_bitrix', 'bookings', 'warning'], ['booking.recreated_in_bitrix', 'bookings', 'warning'],
    ['booking.rolled_back', 'bookings', 'warning'], ['booking.accepted_bitrix', 'bookings', 'info'],
    ['booking.paid', 'payments', 'info'], ['booking.payment_cancelled', 'payments', 'warning'],
    ['deal.edit_open', 'crm', 'info'], ['deal.update', 'crm', 'info'],
    ['payment.link_sent', 'payments', 'info'], ['payment.link_not_sent', 'payments', 'warning'],
    ['payment.paid', 'payments', 'info'], ['payment.expired', 'payments', 'warning'], ['payment.cancelled_in_bitrix', 'payments', 'warning'],
    ['certificate.issued', 'payments', 'info'], ['certificate.changed', 'payments', 'info'], ['certificate.redeemed', 'payments', 'warning'],
    ['resource.stop', 'resources', 'warning'], ['resource.stop_lift', 'resources', 'info'],
    ['chat.reply_status', 'communications', 'info'], ['chat.dashboard_hidden', 'communications', 'info'],
    ['chat_folder.global', 'security', 'high'], ['future.unknown', 'other', 'info'],
  ] as const)('%s → %s / %s', (action, category, severity) => {
    expect(classifyActionLog({ action })).toEqual({ category, severity });
  });
  it.each(['members', 'admins', 'appUsers', 'heads', 'permissions', 'rolePermissions', 'resourceIds', 'features'])('изменение %s — безопасность, даже вместе с обычными настройками', (field) => {
    for (const action of ['group.update', 'settings.update']) expect(classifyActionLog({ action, details: { changes: [{ field: 'name' }, { field }] } })).toEqual({ category: 'security', severity: 'high' });
  });
  it('создание группы с участниками выдаёт доступ', () => {
    expect(classifyActionLog({ action: 'group.create', details: { after: { members: [{ userId: 7 }] } } })).toEqual({ category: 'security', severity: 'high' });
  });
  it.each([
    ['POST /api/settings-access', 'security'], ['POST /api/admin/settings-codes', 'security'], ['PUT /api/admin/external-users/:id/password', 'security'],
    ['PUT /api/admin/booking-sync/deal-fields', 'integration'], ['POST /api/admin/placements/rebind', 'integration'],
    ['POST /api/payments', 'payments'], ['POST /api/certificates/sale', 'payments'], ['PUT /api/openlines/templates/:id', 'settings'],
    ['POST /api/openlines/files/disk', 'communications'], ['POST /api/openlines/chats/:chatId/send', 'communications'],
    ['PUT /api/openlines/favorites/:chatId', 'communications'], ['DELETE /api/openlines/folder-chats/:chatId', 'communications'],
    ['POST /api/bookings/:bookingId/remove-in-app', 'bookings'], ['POST /api/booking-alerts/:id/resolve', 'bookings'],
    ['POST /api/resource-stops/check', 'resources'], ['PUT /api/admin/resources/:resourceId', 'resources'],
    ['PUT /api/dashboard/layout', 'settings'], ['POST /api/workday/:action', 'other'],
  ] as const)('общий перехватчик %s → %s', (route, category) => expect(classifyActionLog({ action: 'request', details: { route } }).category).toBe(category));
  it('ошибка маршрута важнее его доменной категории; 403/409 — средняя критичность', () => {
    expect(classifyActionLog({ action: 'request', details: { route: 'PUT /api/admin/settings', error: 'HTTP', httpStatus: 500 } })).toEqual({ category: 'errors', severity: 'high' });
    expect(classifyActionLog({ action: 'request', details: { error: 'Conflict', httpStatus: 409 } }).severity).toBe('warning');
    expect(classifyActionLog({ action: 'bitrix.error', details: { method: 'crm.deal.get', code: 'HTTP_ERROR' } })).toEqual({ category: 'errors', severity: 'high' });
  });
  it('устойчив к старым/неполным details и не меняет их', () => {
    const details = { changes: [null, { field: 'members', before: [], after: [7] }] };
    const original = JSON.stringify(details); classifyActionLog({ action: 'group.update', details });
    expect(JSON.stringify(details)).toBe(original);
    expect(classifyActionLog({ action: 'group.update', details: null }).category).toBe('settings');
  });
});

it('контактные удаления и отклонения заметны в CRM-журнале, поля относятся к настройкам', () => {
  expect(classifyActionLog({ action:'contact.deleted_in_bitrix' })).toEqual({category:'crm',severity:'high'});
  expect(classifyActionLog({ action:'contact.changed_in_bitrix',details:{deviations:[{field:'NAME'}]} })).toEqual({category:'crm',severity:'warning'});
  expect(classifyActionLog({ action:'contact.missing_in_bitrix' })).toEqual({category:'crm',severity:'warning'});
  expect(classifyActionLog({ action:'fields.mappings.updated' })).toEqual({category:'settings',severity:'info'});
});
