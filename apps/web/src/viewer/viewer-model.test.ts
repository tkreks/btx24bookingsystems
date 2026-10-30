import { describe, expect, it } from 'vitest';
import type { ViewerBookingDto, ViewerDayDto } from '@btx24/shared';
import { availability, blockSize, gridHours, timeStatus } from './viewer-model.js';

const msk = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 31, h - 3, m)).toISOString();
const booking = (id: number, s: number, e: number, resourceIds = [1]): ViewerBookingDto => ({
  bookingId: id, title: `Бронь ${id}`, startsAt: msk(s), endsAt: msk(e), resourceIds, dealId: null, clientName: null, guests: null, programGuests: null,
  amount: null, paid: null, currency: 'RUB', lastPaymentAt: null, lastPaymentAmount: null, payments: [], comment: null, important: null, products: false,
});
const day = (bookings: ViewerBookingDto[], techWindows: ViewerDayDto['techWindows'] = []): ViewerDayDto => ({
  date: '2026-10-31', timezone: 'Europe/Moscow', groupId: '', resources: [{ id: 1, name: 'Зал № 2' }], bookings, techWindows, syncedAt: null,
});

describe('экран «Бронирования»: доступность', () => {
  it('свободные окна, загрузка и самое длинное окно за сутки', () => {
    const a = availability(day([booking(1, 13, 16), booking(2, 18, 20)]), 1, Date.parse(msk(14)));
    expect(a.busyMinutes).toBe(300);
    expect(a.freeMinutes).toBe(24 * 60 - 300);
    expect(a.load).toBe(21);
    expect(a.longestFree).toBe(13 * 60);
    expect(a.free).toHaveLength(3);
    expect(a.freeNow).toBe(false);
    expect(a.pieces.map((p) => p.kind)).toEqual(['free', 'busy', 'free', 'busy', 'free']);
  });
  it('тех. окно — отдельный отрезок внутри свободного времени, свободным временем остаётся', () => {
    // «Сейчас» — вне дня брони: иначе в день из фикстуры (31.10.2026) freeNow зависит от часов машины.
    const a = availability(day([booking(1, 13, 16)], [{ resourceId: 1, startsAt: msk(16), endsAt: msk(16, 30) }]), 1, Date.parse('2026-11-02T12:00:00Z'));
    expect(a.pieces.map((p) => p.kind)).toEqual(['free', 'busy', 'tech', 'free']);
    expect(a.freeMinutes).toBe(21 * 60);
    expect(a.freeNow).toBeNull();
  });
});

describe('экран «Бронирования»: календарь', () => {
  it('часы сетки расширяются под брони; размер блока по высоте', () => {
    expect(gridHours(day([booking(1, 13, 16)]))).toEqual({ from: 8, to: 22 });
    expect(gridHours(day([booking(1, 6, 23)]))).toEqual({ from: 6, to: 23 });
    expect(blockSize(40)).toBe('sm');
    expect(blockSize(100)).toBe('md');
    expect(blockSize(200)).toBe('lg');
  });
  it('статус по времени', () => {
    const b = booking(1, 13, 16);
    expect(timeStatus(b, Date.parse(msk(12)))).toBe('upcoming');
    expect(timeStatus(b, Date.parse(msk(14)))).toBe('now');
    expect(timeStatus(b, Date.parse(msk(17)))).toBe('done');
  });
});
