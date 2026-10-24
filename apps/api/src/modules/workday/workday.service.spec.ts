import { WorkdayService } from './workday.service.js';
import { Bitrix24Error } from '../bitrix24/rest/errors.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import type { PrismaService } from '../../prisma/prisma.service.js';

type Row = Record<string, unknown> & { id: string; portalId: string; userId: number };
type Where = { portalId_userId?: { portalId: string; userId: number }; id?: string };

/** База рабочего дня в памяти: WorkdayState (портал + сотрудник) и WorkdayEvent. */
function fakePrisma() {
  const states: Row[] = [];
  const events: Row[] = [];
  let n = 0;
  const find = (w: Where) =>
    states.find((r) => (w.id ? r.id === w.id : r.portalId === w.portalId_userId!.portalId && r.userId === w.portalId_userId!.userId));
  const prisma = {
    workdayState: {
      findUnique: vi.fn(async ({ where }: { where: Where }) => find(where) ?? null),
      update: vi.fn(async ({ where, data }: { where: Where; data: object }) => Object.assign(find(where)!, data)),
      upsert: vi.fn(async ({ where, create, update }: { where: Where; create: Row; update: object }) => {
        const r = find(where);
        if (r) return Object.assign(r, update);
        const row = { pendingAction: null, pendingReport: null, syncError: null, ...create, id: `s${++n}` };
        states.push(row);
        return row;
      }),
    },
    workdayEvent: {
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row = { ...data, id: `e${++n}` };
        events.push(row);
        return row;
      }),
      deleteMany: vi.fn(async ({ where }: { where: { id: string } }) => {
        const i = events.findIndex((e) => e.id === where.id);
        if (i >= 0) events.splice(i, 1);
        return { count: i >= 0 ? 1 : 0 };
      }),
    },
  };
  return { prisma: prisma as unknown as PrismaService, states, events };
}

const user = (call: ReturnType<typeof vi.fn>, portalId = 'p1') => ({ portal: { id: portalId }, userId: 7, client: { call } }) as unknown as B24UserContext;
const day = (STATUS: string, extra: object = {}) => ({ result: { STATUS, TIME_START: '2026-10-21T09:00:00+03:00', DURATION: '03:10:00', TIME_LEAKS: '00:15:00', ...extra } });
/** Портал с рабочим днём в состоянии `status`; действия меняют его, как Битрикс24. */
function portal(initial: string) {
  let status = initial;
  const call = vi.fn(async (method: string, _params?: object) => {
    if (method === 'timeman.open') status = 'OPENED';
    if (method === 'timeman.pause') status = 'PAUSED';
    if (method === 'timeman.close') status = 'CLOSED';
    return day(status);
  });
  return { call, set: (s: string) => void (status = s) };
}

describe('WorkdayService', () => {
  it('читает свой статус (без USER_ID) и запоминает его в базе приложения', async () => {
    const db = fakePrisma();
    const call = vi.fn(async () => day('OPENED'));
    expect(await new WorkdayService(db.prisma).status(user(call))).toEqual({
      available: true,
      reason: null,
      status: 'OPENED',
      timeStart: '2026-10-21T06:00:00.000Z',
      duration: '03:10:00',
      timeLeaks: '00:15:00',
    });
    expect(call).toHaveBeenCalledWith('timeman.status');
    expect(db.states).toEqual([expect.objectContaining({ portalId: 'p1', userId: 7, status: 'OPENED', source: 'bitrix' })]);
    // Свежее — из базы, без Битрикс24.
    call.mockClear();
    expect((await new WorkdayService(db.prisma).status(user(call))).status).toBe('OPENED');
    expect(call).not.toHaveBeenCalled();
  });

  it('нет права timeman или учёт выключен → недоступно с причиной', async () => {
    const noScope = vi.fn(async () => {
      throw new Bitrix24Error('insufficient_scope', 'The request requires higher privileges');
    });
    expect(await new WorkdayService(fakePrisma().prisma).status(user(noScope))).toMatchObject({ available: false, reason: expect.stringContaining('timeman') });
    const disabled = vi.fn(async () => {
      throw new Bitrix24Error('TIMEMAN_TOOL_DISABLED', 'Working time management is disabled.');
    });
    expect(await new WorkdayService(fakePrisma().prisma).status(user(disabled))).toMatchObject({ available: false, reason: expect.stringContaining('выключен') });
  });

  it('действия по статусу; действие приложения — у нас и в Битрикс24, с историей', async () => {
    const db = fakePrisma();
    const p = portal('CLOSED');
    const svc = new WorkdayService(db.prisma);
    expect(await svc.act(user(p.call), 'open')).toMatchObject({ status: 'OPENED' });
    expect(p.call).toHaveBeenCalledWith('timeman.open', {});
    await expect(svc.act(user(p.call), 'open')).rejects.toMatchObject({ status: 400 });
    await expect(svc.act(user(p.call), 'delete')).rejects.toMatchObject({ status: 400 });
    expect(await svc.act(user(p.call), 'pause')).toMatchObject({ status: 'PAUSED' });
    expect(await svc.act(user(p.call), 'open')).toMatchObject({ status: 'OPENED' });
    expect(await svc.act(user(p.call), 'close', '  Ушёл к клиенту  ')).toMatchObject({ status: 'CLOSED' });
    expect(p.call).toHaveBeenLastCalledWith('timeman.close', { REPORT: 'Ушёл к клиенту' });
    expect(db.events.map((e) => [e.action, e.source])).toEqual([
      ['open', 'app'],
      ['pause', 'app'],
      ['resume', 'app'],
      ['close', 'app'],
    ]);
    expect(db.states[0]).toMatchObject({ status: 'CLOSED', source: 'app', pendingAction: null });
  });

  it('день закрыли в Битрикс24 — при сверке закрывается и в приложении', async () => {
    const db = fakePrisma();
    const p = portal('CLOSED');
    const svc = new WorkdayService(db.prisma);
    await svc.act(user(p.call), 'open');
    p.set('CLOSED');
    expect(await svc.sync(user(p.call))).toMatchObject({ status: 'CLOSED' });
    expect(db.states[0]).toMatchObject({ status: 'CLOSED', source: 'bitrix' });
    expect(db.events.at(-1)).toMatchObject({ action: 'close', source: 'bitrix' });
  });

  it('Битрикс24 недоступен — день начат в приложении, действие уходит при следующей сверке', async () => {
    const db = fakePrisma();
    const p = portal('CLOSED');
    const svc = new WorkdayService(db.prisma);
    await svc.status(user(p.call));
    const down = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    expect(await svc.act(user(down), 'open')).toMatchObject({ status: 'OPENED', pending: true });
    expect(db.states[0]).toMatchObject({ status: 'OPENED', pendingAction: 'open' });
    // Битрикс24 снова доступен: сначала передаём своё действие, потом принимаем его состояние.
    expect(await svc.sync(user(p.call))).toEqual(expect.not.objectContaining({ pending: true }));
    expect(p.call).toHaveBeenCalledWith('timeman.open', {});
    expect(db.states[0]).toMatchObject({ status: 'OPENED', pendingAction: null });
  });

  it('Битрикс24 отклонил действие — состояние портала, история без отменённого, понятная ошибка', async () => {
    const db = fakePrisma();
    const p = portal('OPENED');
    const svc = new WorkdayService(db.prisma);
    await svc.status(user(p.call));
    p.call.mockImplementation(async (method: string) => {
      if (method === 'timeman.pause') throw new Bitrix24Error('WRONG_STATE', 'Day is not opened');
      return day('CLOSED');
    });
    await expect(svc.act(user(p.call), 'pause')).rejects.toMatchObject({ response: { code: 'WORKDAY_REJECTED' } });
    expect(db.states[0]).toMatchObject({ status: 'CLOSED', pendingAction: null });
    expect(db.events.filter((e) => e.source === 'app')).toEqual([]);
  });

  it('незакрытый прошлый день закрывается рекомендованным временем и пояснением', async () => {
    const db = fakePrisma();
    const call = vi.fn(async (method: string, _params?: object) =>
      method === 'timeman.status' ? day('EXPIRED', { TIME_FINISH_DEFAULT: '2026-10-20T21:00:00+03:00' }) : day('CLOSED'),
    );
    await new WorkdayService(db.prisma).act(user(call), 'close');
    expect(call).toHaveBeenLastCalledWith('timeman.close', {
      TIME: '2026-10-20T21:00:00+03:00',
      REPORT: expect.stringContaining('приложения бронирования'),
    });
  });

  it('порталы раздельны: день одного портала не виден в другом', async () => {
    const db = fakePrisma();
    await new WorkdayService(db.prisma).status(user(vi.fn(async () => day('OPENED')), 'p1'));
    await new WorkdayService(db.prisma).status(user(vi.fn(async () => day('CLOSED')), 'p2'));
    expect(db.states.map((s) => [s.portalId, s.status])).toEqual([
      ['p1', 'OPENED'],
      ['p2', 'CLOSED'],
    ]);
  });
});
