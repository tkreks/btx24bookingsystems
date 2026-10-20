import { makePortalService, MEMBER, CLIENT_ENDPOINT } from '../testing/fakes.js';
import type { TokenSet } from '../oauth/oauth.client.js';

const tokens = (over: Partial<TokenSet> = {}): TokenSet => ({
  accessToken: 'access-0',
  refreshToken: 'refresh-0',
  expiresAt: new Date(Date.now() + 3600_000),
  memberId: MEMBER,
  clientEndpoint: CLIENT_ENDPOINT,
  serverEndpoint: 'https://oauth.bitrix.info/rest/',
  scope: 'crm',
  userId: 1,
  status: 'L',
  ...over,
});

describe('PortalService', () => {
  it('stores tokens encrypted and the application token only as a hash', async () => {
    const { service, portals } = makePortalService();
    await service.saveInstallation(tokens(), 'app-token');
    const p = portals[0];
    expect(p.domain).toBe('portal.example.ru');
    expect(p.accessTokenEnc).not.toContain('access-0');
    expect(p.refreshTokenEnc).not.toContain('refresh-0');
    expect(p.applicationTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(p)).not.toContain('app-token');
  });

  it('uses the stored token while it is fresh', async () => {
    const { service, b24 } = makePortalService();
    b24.rest['app.info'] = { result: { ID: 1 } };
    const portal = await service.saveInstallation(tokens(), 't');
    await service.clientFor(portal).call('app.info');
    expect(b24.restCalls[0].body.auth).toBe('access-0');
    expect(b24.oauthCalls).toHaveLength(0);
  });

  it('refreshes ahead of expiry and persists the rotated pair', async () => {
    const { service, b24, portals, box } = makePortalService();
    b24.rest['app.info'] = { result: 1 };
    const portal = await service.saveInstallation(tokens({ expiresAt: new Date(Date.now() + 10_000) }), 't');
    await service.clientFor(portal).call('app.info');
    expect(b24.restCalls[0].body.auth).toBe('access-1');
    expect(box.decrypt(portals[0].refreshTokenEnc!)).toBe('refresh-1');
  });

  it('runs a single refresh for concurrent expired_token responses', async () => {
    const { service, b24 } = makePortalService();
    b24.rest['app.info'] = (body: Record<string, unknown>) => (body.auth === 'access-0' ? { error: 'expired_token' } : { result: 1 });
    const portal = await service.saveInstallation(tokens(), 't');
    const client = service.clientFor(portal);
    await Promise.all([client.call('app.info'), client.call('app.info'), client.call('app.info')]);
    expect(b24.oauthCalls).toHaveLength(1);
  });

  it('picks up tokens refreshed by another process instead of burning the refresh token', async () => {
    const { service, b24, portals, box } = makePortalService();
    b24.rest['app.info'] = (body: Record<string, unknown>) => (body.auth === 'access-0' ? { error: 'expired_token' } : { result: 1 });
    const portal = await service.saveInstallation(tokens(), 't');
    portals[0].accessTokenEnc = box.encrypt('access-from-worker');
    await service.clientFor(portal).call('app.info');
    expect(b24.oauthCalls).toHaveLength(0);
    expect(b24.restCalls.at(-1)!.body.auth).toBe('access-from-worker');
  });

  it('turns a rejected refresh token into REAUTH_REQUIRED', async () => {
    const { service, b24 } = makePortalService();
    b24.oauth = () => ({ status: 401, body: { error: 'invalid_grant' } });
    const portal = await service.saveInstallation(tokens({ expiresAt: new Date(Date.now() - 1000) }), 't');
    await expect(service.clientFor(portal).call('app.info')).rejects.toMatchObject({ code: 'REAUTH_REQUIRED' });
  });

  it('wipes tokens on uninstall and stops serving the portal', async () => {
    const { service, portals } = makePortalService();
    const portal = await service.saveInstallation(tokens(), 't');
    await service.markUninstalled(portal.id);
    expect(portals[0]).toMatchObject({ status: 'UNINSTALLED', accessTokenEnc: null, refreshTokenEnc: null });
    await expect(service.findActiveByMemberId(MEMBER)).resolves.toBeNull();
    await expect(service.clientFor(portal).call('app.info')).rejects.toMatchObject({ code: 'PORTAL_INACTIVE' });
  });
});
