import { chatMinutes, isSystemMessage, shiftOwner, shiftSpan, summarize } from './activity.js';

const t = (hhmm: string) => Date.parse(`2026-10-23T${hhmm}:00+03:00`);

describe('activity', () => {
  it('phone message goes to whoever is on shift; one shift that day — to that person; none — nobody', () => {
    const shifts = [
      { userId: 236, start: t('09:00'), end: t('15:00') },
      { userId: 270, start: t('14:00'), end: null },
    ];
    expect(shiftOwner(shifts, t('10:00'))).toBe(236);
    // Смены двоих совпали — приписать одному нельзя.
    expect(shiftOwner(shifts, t('14:30'))).toEqual({ shared: [236, 270] });
    // Второй выключил рабочий день — только первый.
    expect(shiftOwner([{ userId: 270, start: t('08:00') - 86_400_000 * 5, end: null }, { userId: 236, start: t('09:00'), end: t('12:00') }], t('13:00'), t('21:00'))).toBe(270);
    expect(shiftOwner(shifts, t('20:00'), t('21:00'))).toBe(270);
    expect(shiftOwner([{ userId: 236, start: t('09:00'), end: t('12:00') }], t('13:00'))).toBe(236);
    expect(shiftOwner([], t('13:00'))).toBeNull();
  });

  it('shiftSpan: from first start to last end; an open record — till now', () => {
    const shifts = [
      { userId: 1, start: t('09:00'), end: t('12:00') },
      { userId: 1, start: t('14:00'), end: t('18:00') },
      { userId: 2, start: t('10:00'), end: null },
    ];
    expect(shiftSpan(shifts, 1)).toEqual({ start: t('09:00'), end: t('18:00') });
    expect(shiftSpan(shifts, 2)).toEqual({ start: t('10:00'), end: null });
    expect(shiftSpan(shifts, 3)).toBeNull();
  });

  it('app auto-messages are not the employee’s work: by message id or by chat, sender and time', () => {
    const marks = [
      { chatId: 1, messageId: 500, userId: 236, sentAt: t('10:00') },
      { chatId: 2, messageId: null, userId: 236, sentAt: t('11:00') },
    ];
    expect(isSystemMessage(marks, 1, 500, 236, t('10:00'))).toBe(true);
    expect(isSystemMessage(marks, 2, 9, 236, t('11:00') + 30_000)).toBe(true);
    expect(isSystemMessage(marks, 2, 9, 236, t('11:05'))).toBe(false);
    expect(isSystemMessage(marks, 2, 9, 270, t('11:00'))).toBe(false);
  });

  it('chat minutes: messages within 10 minutes are one session, at least 2 minutes each', () => {
    expect(chatMinutes([])).toBe(0);
    expect(chatMinutes([t('10:00')])).toBe(2);
    expect(chatMinutes([t('10:00'), t('10:05'), t('10:12')])).toBe(12);
    expect(chatMinutes([t('10:00'), t('10:30')])).toBe(4);
  });

  it('summarize buckets events by all24 portal hours and totals everything', () => {
    const e = (hhmm: string, kind: 'call' | 'chat', durationSec: number | null = null) => ({ at: new Date(t(hhmm)).toISOString(), kind, text: '', durationSec, dealId: null, chatId: null });
    const s = summarize({ userId: 1, name: 'Анна', shift: null, photo: null }, [e('09:15', 'call', 125), e('09:40', 'chat'), e('21:59', 'chat'), e('23:10', 'chat')], 'Europe/Moscow');
    expect(s.hours).toHaveLength(24);
    expect(s.hours[9]).toMatchObject({ call: 1, chat: 1 });
    expect(s.hours[21]).toMatchObject({ chat: 1 });
    expect(s.totals).toMatchObject({ call: 1, chat: 3 });
    expect(s.callMinutes).toBe(2);
    expect(s.events[0].kind).toBe('call');
  });
});
