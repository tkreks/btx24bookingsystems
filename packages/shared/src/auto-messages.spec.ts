import { describe, expect, it } from 'vitest';
import { autoSendAt, inSendWindow } from './auto-messages.js';

const rule = { hoursBefore: 24, windowFrom: '09:00', windowTo: '22:00' };
const tz = 'Europe/Moscow';
const msk = (s: string) => Date.parse(`${s}+03:00`);

describe('autoSendAt', () => {
  it('за сутки, если это рабочее время накануне', () => {
    expect(autoSendAt(msk('2026-10-24T15:00:00'), rule, tz)).toBe(msk('2026-10-23T15:00:00'));
  });
  it('бронь поздно вечером — накануне до конца окна; рано утром — накануне в 9:00', () => {
    expect(autoSendAt(msk('2026-10-24T23:30:00'), rule, tz)).toBe(msk('2026-10-23T21:50:00'));
    expect(autoSendAt(msk('2026-10-24T07:00:00'), rule, tz)).toBe(msk('2026-10-23T09:00:00'));
  });
  it('к началу брони не успеть — не отправлять', () => {
    expect(autoSendAt(msk('2026-10-24T08:00:00'), { hoursBefore: 1, windowFrom: '09:00', windowTo: '22:00' }, tz)).toBeNull();
  });
  it('окно — по времени портала', () => {
    expect(inSendWindow(msk('2026-10-23T09:00:00'), rule, tz)).toBe(true);
    expect(inSendWindow(msk('2026-10-23T22:00:00'), rule, tz)).toBe(false);
    expect(inSendWindow(msk('2026-10-23T08:59:00'), rule, tz)).toBe(false);
  });
});
