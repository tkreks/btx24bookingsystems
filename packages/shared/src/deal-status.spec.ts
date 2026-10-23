import { describe, expect, it } from 'vitest';
import { dealStatus } from './deal-status.js';

const now = Date.parse('2026-10-23T12:00:00Z');
const b = (start: string, end: string) => ({ start, end });

describe('dealStatus', () => {
  it('канбан: провал и успех — как есть, независимо от брони', () => {
    expect(dealStatus({ stageSemantic: 'F', bookings: [b('2026-10-24T10:00:00Z', '2026-10-24T12:00:00Z')] }, now).status).toBe('failed');
    expect(dealStatus({ stageSemantic: 'S', bookings: [] }, now)).toEqual({ status: 'done', needsClose: false, bookingEnd: null });
  });

  it('в работе: бронь впереди или идёт — ожидание клиента; без брони — в работе', () => {
    expect(dealStatus({ stageSemantic: 'P', bookings: [b('2026-10-24T10:00:00Z', '2026-10-24T12:00:00Z')] }, now).status).toBe('waiting');
    expect(dealStatus({ stageSemantic: 'P', bookings: [b('2026-10-23T11:00:00Z', '2026-10-23T13:00:00Z')] }, now).status).toBe('waiting');
    expect(dealStatus({ stageSemantic: 'P', bookings: [] }, now)).toEqual({ status: 'in_work', needsClose: false, bookingEnd: null });
  });

  it('в работе, а бронь прошла — завершена, но надо закрыть в Битрикс24', () => {
    expect(dealStatus({ stageSemantic: 'P', bookings: [b('2026-10-22T10:00:00Z', '2026-10-22T12:00:00Z')] }, now)).toEqual({
      status: 'done',
      needsClose: true,
      bookingEnd: '2026-10-22T12:00:00.000Z',
    });
    // Одна прошла, другая впереди — ждём клиента.
    expect(dealStatus({ stageSemantic: 'P', bookings: [b('2026-10-20T10:00:00Z', '2026-10-20T12:00:00Z'), b('2026-10-30T10:00:00Z', '2026-10-30T12:00:00Z')] }, now).status).toBe('waiting');
  });

  it('журнал о сделке не знает — поле конца брони; знает (брони сняты) — поле не в счёт', () => {
    expect(dealStatus({ stageSemantic: 'P', bookings: null, fieldEnd: '2026-12-01T10:00:00+03:00' }, now).status).toBe('waiting');
    expect(dealStatus({ stageSemantic: 'P', bookings: null, fieldEnd: '2026-10-01T10:00:00+03:00' }, now)).toMatchObject({ status: 'done', needsClose: true });
    expect(dealStatus({ stageSemantic: 'P', bookings: [], fieldEnd: '2026-10-01T10:00:00+03:00' }, now).status).toBe('in_work');
    expect(dealStatus({ stageSemantic: 'P', bookings: null, fieldEnd: '' }, now).status).toBe('in_work');
  });
});
