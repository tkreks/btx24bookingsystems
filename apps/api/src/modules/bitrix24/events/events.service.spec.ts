import { EventsService } from './events.service.js';
import { makePortalService, MEMBER, CLIENT_ENDPOINT } from '../testing/fakes.js';

async function setup() {
  const ctx = makePortalService();
  await ctx.service.saveInstallation(
    { accessToken: 'a', refreshToken: 'r', expiresAt: new Date(Date.now() + 3600_000), memberId: MEMBER, clientEndpoint: CLIENT_ENDPOINT, serverEndpoint: 'https://oauth.bitrix.info/rest/', scope: '', userId: 1, status: 'L' },
    'app-token',
  );
  return { ...ctx, svc: new EventsService(ctx.prisma, ctx.service) };
}

const auth = { member_id: MEMBER, application_token: 'app-token', domain: 'portal.example.ru', access_token: 'secret-access', refresh_token: 'secret-refresh' };

describe('EventsService', () => {
  it('rejects events with a wrong application_token, unknown portal or no auth', async () => {
    const { svc, events } = await setup();
    await expect(svc.receive({ event: 'ONAPPUNINSTALL', auth: { ...auth, application_token: 'forged' } })).resolves.toBe('rejected');
    await expect(svc.receive({ event: 'ONAPPUNINSTALL', auth: { ...auth, member_id: 'other' } })).resolves.toBe('rejected');
    await expect(svc.receive({ event: 'ONAPPUNINSTALL' })).resolves.toBe('rejected');
    expect(events).toHaveLength(0);
  });

  it('processes ONAPPUNINSTALL: portal deactivated, tokens wiped, event marked processed', async () => {
    const { svc, portals, events } = await setup();
    await expect(svc.receive({ event: 'onappuninstall', data: { CLEAN: 0 }, auth })).resolves.toBe('processed');
    expect(portals[0]).toMatchObject({ status: 'UNINSTALLED', accessTokenEnc: null, refreshTokenEnc: null });
    expect(events[0]).toMatchObject({ event: 'ONAPPUNINSTALL', status: 'PROCESSED' });
  });

  it('stores other events as pending and never stores auth tokens', async () => {
    const { svc, events } = await setup();
    await expect(svc.receive({ event: 'ONBOOKINGADD', data: { FIELDS: { ID: 5 } }, auth })).resolves.toBe('stored');
    expect(events[0]).toMatchObject({ event: 'ONBOOKINGADD', status: 'PENDING', payload: { data: { FIELDS: { ID: 5 } }, domain: 'portal.example.ru' } });
    const raw = JSON.stringify(events[0]);
    expect(raw).not.toContain('secret-access');
    expect(raw).not.toContain('secret-refresh');
    expect(raw).not.toContain('app-token');
  });

  it('звонок: начало — номер клиента, ответ — сотрудник, конец — итог; порядок событий не важен', async () => {
    const { svc, calls, events } = await setup();
    await expect(svc.receive({ event: 'ONVOXIMPLANTCALLSTART', data: { CALL_ID: 'c-1', USER_ID: '236' }, auth })).resolves.toBe('processed');
    await svc.receive({ event: 'ONVOXIMPLANTCALLINIT', data: { CALL_ID: 'c-1', CALL_TYPE: '2', CALLER_ID: '+79001234567', PHONE_NUMBER: '74950000000' }, auth });
    await svc.receive({ event: 'ONVOXIMPLANTCALLEND', data: { CALL_ID: 'c-1', CALL_TYPE: '2', PHONE_NUMBER: '', PORTAL_USER_ID: '236', CRM_ACTIVITY_ID: '777' }, auth });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ callId: 'c-1', callType: 2, phone: '+79001234567', userId: 236, crmActivityId: 777 });
    expect(calls[0].answeredAt).toBeInstanceOf(Date);
    expect(calls[0].endedAt).toBeInstanceOf(Date);
    expect(events.every((e) => e.status === 'PROCESSED')).toBe(true);
    // Исходящий: номер клиента — набираемый.
    await svc.receive({ event: 'ONVOXIMPLANTCALLINIT', data: { CALL_ID: 'c-2', CALL_TYPE: '1', CALLER_ID: 'reg1', PHONE_NUMBER: '+79005550000' }, auth });
    expect(calls[1]).toMatchObject({ callId: 'c-2', callType: 1, phone: '+79005550000' });
  });
});
