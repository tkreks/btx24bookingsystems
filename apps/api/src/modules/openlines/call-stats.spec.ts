import { classifyCalls, clientKey, type CallActivity } from './call-stats.js';

let id = 0;
const call = (dir: 1 | 2, at: string, phone: string | null, missed = false, responsible = 7, owner: [number, number] = [2, 100]): CallActivity => ({
  ID: String(++id),
  OWNER_TYPE_ID: String(owner[0]),
  OWNER_ID: String(owner[1]),
  DIRECTION: String(dir),
  START_TIME: at,
  RESPONSIBLE_ID: String(responsible),
  SETTINGS: missed ? { IS_DESCRIPTION_ONLY: true, MISSED_CALL: true } as never : [],
  COMMUNICATIONS: phone ? [{ VALUE: phone }] : [],
});

const start = new Date('2026-10-21T00:00:00Z');
const end = new Date('2026-10-22T00:00:00Z');

describe('classifyCalls', () => {
  it('counts incoming, answered, missed and lost (no callback, one per client)', () => {
    const calls = [
      call(1, '2026-10-21T09:00:00Z', '+7 985 111-11-11'), // отвечен
      call(1, '2026-10-21T10:00:00Z', '89852222222', true), // пропущен → перезвонили
      call(2, '2026-10-21T10:30:00Z', '+79852222222'),
      call(1, '2026-10-21T11:00:00Z', '+79853333333', true), // пропущен дважды, не перезвонили → 1 упущенный
      call(1, '2026-10-21T12:00:00Z', '+79853333333', true),
      call(1, '2026-10-21T13:00:00Z', '+79854444444', true), // пропущен, потом сам дозвонился → не упущен
      call(1, '2026-10-22T08:00:00Z', '+79854444444'), // после периода — тоже считается
      call(1, '2026-10-20T13:00:00Z', '+79855555555', true), // до периода — не в счёт
      call(2, '2026-10-21T14:00:00Z', '+79856666666'), // исходящий — не входящий
    ];
    const r = classifyCalls(calls, start, end, null);
    expect(r.incoming).toHaveLength(5);
    expect(r.answered).toHaveLength(1);
    expect(r.missed).toHaveLength(4);
    expect(r.lost.map((c) => clientKey(c))).toEqual(['9853333333']);
    expect(r.lost[0].START_TIME).toBe('2026-10-21T12:00:00Z');
  });

  it('mine: only my incoming, but a colleague’s callback still counts', () => {
    const calls = [
      call(1, '2026-10-21T10:00:00Z', '+79857777777', true, 7),
      call(2, '2026-10-21T11:00:00Z', '+79857777777', false, 8),
      call(1, '2026-10-21T12:00:00Z', '+79858888888', true, 8),
    ];
    const r = classifyCalls(calls, start, end, 7);
    expect(r.missed).toHaveLength(1);
    expect(r.lost).toHaveLength(0);
  });

  it('without a phone the client is the CRM item', () => {
    const r = classifyCalls([call(1, '2026-10-21T10:00:00Z', null, true, 7, [3, 5]), call(2, '2026-10-21T11:00:00Z', null, false, 7, [3, 5])], start, end, null);
    expect(r.lost).toHaveLength(0);
  });
});
