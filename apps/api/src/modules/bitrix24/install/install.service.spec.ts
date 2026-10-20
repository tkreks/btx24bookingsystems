import { InstallService } from './install.service.js';
import { makePortalService, MEMBER } from '../testing/fakes.js';

const request = { REFRESH_ID: 'frame-refresh', SERVER_ENDPOINT: 'https://oauth.bitrix.info/rest/', APPLICATION_TOKEN: 'app-token', member_id: MEMBER, DOMAIN: 'portal.example.ru' };

function setup(config = {}) {
  const ctx = makePortalService({ config });
  return { ...ctx, install: new InstallService(ctx.service, ctx.oauth, ctx.config) };
}

describe('InstallService', () => {
  it('trusts the authorization server, checks admin rights, saves the portal and binds events', async () => {
    const { install, portals, b24 } = setup();
    await expect(install.install(request)).resolves.toEqual({ memberId: MEMBER, domain: 'portal.example.ru' });
    expect(b24.oauthCalls[0].searchParams.get('refresh_token')).toBe('frame-refresh');
    expect(portals[0].status).toBe('ACTIVE');
    const bind = b24.restCalls.find((c) => c.method === 'event.bind')!;
    expect(bind.body).toMatchObject({ event: 'ONAPPUNINSTALL', handler: 'https://app.example.ru/api/b24/events' });
  });

  it('rejects an install whose SERVER_ENDPOINT is not trusted (forged request)', async () => {
    const { install, portals, b24 } = setup();
    await expect(install.install({ ...request, SERVER_ENDPOINT: 'https://evil.example/rest/' })).rejects.toMatchObject({ code: 'UNTRUSTED_OAUTH_SERVER' });
    expect(b24.oauthCalls).toHaveLength(0);
    expect(portals).toHaveLength(0);
  });

  it('rejects when the posted member_id differs from the authorization server', async () => {
    const { install, portals } = setup();
    await expect(install.install({ ...request, member_id: 'someone-else' })).rejects.toMatchObject({ code: 'MEMBER_MISMATCH' });
    expect(portals).toHaveLength(0);
  });

  it('allows only administrators to install', async () => {
    const { install, portals, b24 } = setup();
    b24.rest['user.admin'] = { result: false };
    await expect(install.install(request)).rejects.toMatchObject({ code: 'NOT_ADMIN' });
    expect(portals).toHaveLength(0);
  });

  it('is idempotent on reinstall (handler already bound)', async () => {
    const { install, portals, b24 } = setup();
    await install.install(request);
    b24.rest['event.bind'] = { error: 'ERROR_CORE', error_description: 'Handler already binded' };
    await expect(install.install(request)).resolves.toMatchObject({ memberId: MEMBER });
    expect(portals).toHaveLength(1);
  });

  it('still installs in read-only mode (only app registration calls are made)', async () => {
    const { install, portals } = setup({ readOnly: true });
    await expect(install.install(request)).resolves.toMatchObject({ memberId: MEMBER });
    expect(portals).toHaveLength(1);
  });

  it('requires the mandatory install fields', async () => {
    const { install } = setup();
    await expect(install.install({ DOMAIN: 'x' })).rejects.toMatchObject({ code: 'BAD_INSTALL_REQUEST' });
  });
});
