import { callClients, clientKey, type CallActivity } from './call-stats.js';

let id = 0;
const call = (
  dir: 1 | 2,
  at: string,
  phone: string | null,
  o: { missed?: boolean; responsible?: number; contact?: number; owner?: [number, number] } = {},
): CallActivity => ({
  ID: String(++id),
  OWNER_TYPE_ID: String(o.owner?.[0] ?? 2),
  OWNER_ID: String(o.owner?.[1] ?? 100),
  DIRECTION: String(dir),
  START_TIME: at,
  RESPONSIBLE_ID: String(o.responsible ?? 7),
  SETTINGS: o.missed ? ({ IS_DESCRIPTION_ONLY: true, MISSED_CALL: true } as never) : [],
  COMMUNICATIONS: phone ? [{ VALUE: phone, ...(o.contact ? { ENTITY_TYPE_ID: '3', ENTITY_ID: String(o.contact) } : {}) }] : [],
});

const start = new Date('2026-10-21T00:00:00Z');
const end = new Date('2026-10-22T00:00:00Z');

describe('callClients', () => {
  it('3 calls from a client and 2 calls to him are one client', () => {
    const calls = [
      call(1, '2026-10-21T09:00:00Z', '+7 985 111-11-11', { missed: true, contact: 5 }),
      call(1, '2026-10-21T09:05:00Z', '89851111111', { missed: true, contact: 5 }),
      call(2, '2026-10-21T09:10:00Z', '+79851111111', { contact: 5 }),
      call(1, '2026-10-21T10:00:00Z', '+79851111111', { contact: 5 }),
      call(2, '2026-10-21T11:00:00Z', '+79851111111', { contact: 5 }),
    ];
    const r = callClients(calls, start, end, null);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ key: 'contact:5', contactId: 5, answered: true, missed: true, lost: false });
    expect(r[0].incoming).toHaveLength(3);
  });

  it('lost: last missed not followed by an answered incoming or an outgoing call (also after the period)', () => {
    const calls = [
      call(1, '2026-10-21T11:00:00Z', '+79853333333', { missed: true }),
      call(1, '2026-10-21T12:00:00Z', '+79853333333', { missed: true }),
      call(1, '2026-10-21T13:00:00Z', '+79854444444', { missed: true }),
      call(1, '2026-10-22T08:00:00Z', '+79854444444'),
      call(1, '2026-10-20T13:00:00Z', '+79855555555', { missed: true }),
    ];
    const r = callClients(calls, start, end, null);
    expect(r.map((c) => [c.key, c.lost])).toEqual([
      ['phone:9854444444', false],
      ['phone:9853333333', true],
    ]);
  });

  it('mine: only my incoming, a colleague’s callback still counts', () => {
    const calls = [
      call(1, '2026-10-21T10:00:00Z', '+79857777777', { missed: true, responsible: 7 }),
      call(2, '2026-10-21T11:00:00Z', '+79857777777', { responsible: 8 }),
      call(1, '2026-10-21T12:00:00Z', '+79858888888', { missed: true, responsible: 8 }),
    ];
    const r = callClients(calls, start, end, 7);
    expect(r).toHaveLength(1);
    expect(r[0].lost).toBe(false);
  });

  it('client key: contact, then phone, then CRM item', () => {
    expect(clientKey(call(1, '2026-10-21T10:00:00Z', '+79850000000', { contact: 9 }))).toBe('contact:9');
    expect(clientKey(call(1, '2026-10-21T10:00:00Z', '8 (985) 000-00-00'))).toBe('phone:9850000000');
    expect(clientKey(call(1, '2026-10-21T10:00:00Z', null, { owner: [3, 5] }))).toBe('crm:3:5');
  });
});
