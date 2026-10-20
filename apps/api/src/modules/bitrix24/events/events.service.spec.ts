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
});
