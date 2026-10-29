import { describe, expect, it } from 'vitest';
import type { BookingAlertDto, ContactAlertDto } from '@btx24/shared';
import { bookingSeverity, bulkAcceptable, contactSeverity, fieldValue, mergeTimeline, realChanges } from './notifications.js';

const booking = (o: Partial<BookingAlertDto>): BookingAlertDto =>
  ({ id: 'b', kind: 'mismatch', title: null, problems: ['time'], bookingId: 1, dealId: null, expected: null, actual: null, status: 'new', statusBy: null, statusAt: null, createdAt: '2026-10-29T10:00:00.000Z', delivered: true, sendError: null, ...o }) as BookingAlertDto;
const contact = (o: Partial<ContactAlertDto>): ContactAlertDto => ({ id: 'c', kind: 'change', changes: [], createdAt: '2026-10-29T11:00:00.000Z', status: 'new', ...o }) as ContactAlertDto;

describe('лента уведомлений', () => {
  it('показывает только реально изменённые поля, множественные — значениями', () => {
    expect(fieldValue([{ VALUE: '+7 900' }, { VALUE: '' }])).toBe('+7 900');
    expect(fieldValue('')).toBe('—');
    const changes = realChanges([
      { field: 'PHONE', before: [{ VALUE: '1' }], after: [{ VALUE: '1', ID: 5 }] },
      { field: 'NAME', before: 'Ира', after: 'Ирина' },
    ] as ContactAlertDto['changes']);
    expect(changes.map((c) => c.field)).toEqual(['NAME']);
  });
  it('критичность: удаление — красный, важные поля — оранжевый, прочее — серый', () => {
    expect(contactSeverity(contact({ kind: 'deleted' }))).toBe('critical');
    expect(contactSeverity(contact({ changes: [{ field: 'NAME', before: 'a', after: 'b' }] as ContactAlertDto['changes'] }))).toBe('warning');
    expect(contactSeverity(contact({ changes: [{ field: 'COMMENTS', before: 'a', after: 'b' }] as ContactAlertDto['changes'] }))).toBe('info');
    expect(bookingSeverity(booking({ problems: ['missing'] }))).toBe('critical');
    expect(bookingSeverity(booking({}))).toBe('warning');
    expect(bookingSeverity(booking({ kind: 'new_booking', problems: [] }))).toBe('info');
  });
  it('«Принять все» не трогает удаления и закрытые', () => {
    expect(bulkAcceptable(booking({}))).toBe(true);
    expect(bulkAcceptable(booking({ problems: ['missing'] }))).toBe(false);
    expect(bulkAcceptable(booking({ status: 'ignored' }))).toBe(false);
  });
  it('одна лента — новые сверху', () => {
    expect(mergeTimeline([booking({})], [contact({})]).map((i) => i.kind)).toEqual(['contact', 'booking']);
  });
});
