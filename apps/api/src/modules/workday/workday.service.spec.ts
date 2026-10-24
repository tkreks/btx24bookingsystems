import { WorkdayService } from './workday.service.js';
import { Bitrix24Error } from '../bitrix24/rest/errors.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';

const user = (call: ReturnType<typeof vi.fn>) => ({ userId: 7, client: { call } }) as unknown as B24UserContext;
const day = (STATUS: string, extra: object = {}) => ({ result: { STATUS, TIME_START: '2026-10-21T09:00:00+03:00', DURATION: '03:10:00', TIME_LEAKS: '00:15:00', ...extra } });

describe('WorkdayService', () => {
  it('reads own status (no USER_ID)', async () => {
    const call = vi.fn(async () => day('OPENED'));
    expect(await new WorkdayService().status(user(call))).toEqual({
      available: true,
      reason: null,
      status: 'OPENED',
      timeStart: '2026-10-21T06:00:00.000Z',
      duration: '03:10:00',
      timeLeaks: '00:15:00',
    });
    expect(call).toHaveBeenCalledWith('timeman.status');
  });

  it('no timeman scope or tool disabled → unavailable with a reason', async () => {
    const noScope = vi.fn(async () => {
      throw new Bitrix24Error('insufficient_scope', 'The request requires higher privileges');
    });
    expect(await new WorkdayService().status(user(noScope))).toMatchObject({ available: false, reason: expect.stringContaining('timeman') });
    const disabled = vi.fn(async () => {
      throw new Bitrix24Error('TIMEMAN_TOOL_DISABLED', 'Working time management is disabled.');
    });
    expect(await new WorkdayService().status(user(disabled))).toMatchObject({ available: false, reason: expect.stringContaining('выключен') });
  });

  it('allows actions by state: closed → open; opened → pause/close; paused → open (resume)/close', async () => {
    const call = vi.fn(async (method: string) => (method === 'timeman.status' ? day('CLOSED') : day('OPENED')));
    expect(await new WorkdayService().act(user(call), 'open')).toMatchObject({ status: 'OPENED' });
    expect(call).toHaveBeenLastCalledWith('timeman.open', {});
    await expect(new WorkdayService().act(user(call), 'pause')).rejects.toMatchObject({ status: 400 });
    await expect(new WorkdayService().act(user(call), 'delete')).rejects.toMatchObject({ status: 400 });
  });

  it('expired day is closed with the recommended time and a reason', async () => {
    const call = vi.fn(async (method: string) =>
      method === 'timeman.status' ? day('EXPIRED', { TIME_FINISH_DEFAULT: '2026-10-20T21:00:00+03:00' }) : day('CLOSED'),
    );
    await new WorkdayService().act(user(call), 'close');
    expect(call).toHaveBeenLastCalledWith('timeman.close', {
      TIME: '2026-10-20T21:00:00+03:00',
      REPORT: expect.stringContaining('приложения бронирования'),
    });
  });

  it('close passes the employee comment as REPORT (only for close)', async () => {
    const call = vi.fn(async (method: string) => (method === 'timeman.status' ? day('OPENED') : day('CLOSED')));
    await new WorkdayService().act(user(call), 'close', '  Ушёл к клиенту  ');
    expect(call).toHaveBeenLastCalledWith('timeman.close', { REPORT: 'Ушёл к клиенту' });
    await new WorkdayService().act(user(call), 'pause', 'не нужен');
    expect(call).toHaveBeenLastCalledWith('timeman.pause', {});
  });
});
