import { alertMessage, diffState, period } from './alert-message.js';

const s = (startsAt: string, endsAt: string, resourceIds: number[], dealId: number | null) => ({ startsAt, endsAt, resourceIds, dealId });
const base = s('2026-10-23T11:00:00.000Z', '2026-10-23T13:00:00.000Z', [10, 11], 678);

describe('alert message', () => {
  it('finds what differs', () => {
    expect(diffState(base, { ...base, resourceIds: [11, 10] })).toEqual([]);
    expect(diffState(base, { ...base, endsAt: '2026-10-23T14:00:00.000Z', dealId: null })).toEqual(['time', 'deal']);
    expect(diffState(base, { ...base, resourceIds: [10] })).toEqual(['resources']);
  });

  it('formats periods in portal time zone', () => {
    expect(period(base, 'Europe/Moscow')).toBe('23.10 14:00–16:00');
    expect(period({ ...base, endsAt: '2026-10-25T09:00:00.000Z' }, 'Europe/Moscow')).toBe('23.10 14:00 – 25.10 12:00');
  });

  it('discrepancy: what differs, both states, status and action buttons', () => {
    const m = alertMessage({
      kind: 'discrepancy',
      problems: ['time'],
      bookingId: 55,
      dealId: 678,
      title: 'Баня',
      expected: base,
      actual: { ...base, startsAt: '2026-10-23T12:00:00.000Z' },
      status: 'resolved',
      statusBy: 'Анна, 21.10 21:30',
      resources: new Map([[10, 'Баня №1']]),
      timeZone: 'Europe/Moscow',
      appPath: '/marketplace/app/12/',
      alertId: 'a1',
    });
    expect(m.MESSAGE).toContain('зафиксировано расхождение данных');
    expect(m.MESSAGE).toContain('В приложении: 23.10 14:00–16:00, Баня №1, Ресурс 11, сделка #678.');
    expect(m.MESSAGE).toContain('В Битрикс24: 23.10 15:00–16:00');
    expect(m.MESSAGE).toContain('Статус: ✅ [b]Решено[/b] — Анна, 21.10 21:30');
    expect(m.KEYBOARD).toEqual([
      expect.objectContaining({ TEXT: 'Открыть сделку', LINK: '/crm/deal/details/678/' }),
      expect.objectContaining({ TEXT: 'Изменить бронь', LINK: '/marketplace/app/12/?alert=a1' }),
      expect.objectContaining({ TEXT: 'Отменить бронь', LINK: '/marketplace/app/12/?alert=a1' }),
    ]);
  });

  it('new booking without deal and without app link: no buttons', () => {
    const m = alertMessage({
      kind: 'new_booking',
      problems: [],
      bookingId: 7,
      dealId: null,
      title: null,
      expected: null,
      actual: { ...base, dealId: null },
      status: 'new',
      statusBy: null,
      resources: new Map(),
      timeZone: 'Europe/Moscow',
      appPath: null,
      alertId: 'a2',
    });
    expect(m.MESSAGE).toContain('Найдено новое бронирование');
    expect(m.MESSAGE).toContain('без сделки');
    expect(m.MESSAGE).toContain('Статус: 🆕 [b]Новый[/b]');
    expect(m.KEYBOARD).toEqual([]);
  });
});
