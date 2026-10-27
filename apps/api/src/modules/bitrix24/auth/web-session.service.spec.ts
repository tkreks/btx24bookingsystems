import type { ExecutionContext } from '@nestjs/common';
import type { Portal } from '../../../generated/prisma/client.js';
import { makePortalService, MEMBER, CLIENT_ENDPOINT } from '../testing/fakes.js';
import { sha256Hex } from '../crypto/secret-box.js';
import { B24AuthGuard } from './b24-auth.guard.js';
import { UserTokenVerifier } from './user-token.verifier.js';
import { WebSessionService, readCookie } from './web-session.service.js';

type Row = Record<string, unknown> & { id: string; tokenHash: string; portalId: string };

async function setup() {
  const ctx = makePortalService();
  const portal = await ctx.service.saveInstallation(
    { accessToken: 'app-a', refreshToken: 'app-r', expiresAt: new Date(Date.now() + 3600_000), memberId: MEMBER, clientEndpoint: CLIENT_ENDPOINT, serverEndpoint: 'https://oauth.bitrix.info/rest/', scope: '', userId: 1, status: 'L' },
    'app-token',
  );
  const rows: Row[] = [];
  const prisma = ctx.prisma as unknown as Record<string, Record<string, unknown>>;
  prisma.portal.findMany = async () => ctx.portals.filter((p) => p.status === 'ACTIVE');
  prisma.webSession = {
    create: async ({ data }: { data: Row }) => rows.push({ ...data, id: `s${rows.length + 1}`, lastSeenAt: new Date(), createdAt: new Date() }),
    findUnique: async ({ where }: { where: { tokenHash: string } }) => {
      const r = rows.find((x) => x.tokenHash === where.tokenHash);
      return r ? { ...r, portal: ctx.portals.find((p) => p.id === r.portalId) } : null;
    },
    update: async ({ where, data }: { where: { id: string }; data: object }) => Object.assign(rows.find((x) => x.id === where.id)!, data),
    updateMany: async ({ where, data }: { where: { id: string; lastSeenAt?: Date }; data: object }) => {
      const r = rows.find((x) => x.id === where.id && (!where.lastSeenAt || (x.lastSeenAt as Date).getTime() === where.lastSeenAt.getTime()));
      if (r) Object.assign(r, data);
      return { count: r ? 1 : 0 };
    },
    deleteMany: async ({ where }: { where: { id?: string; tokenHash?: string } }) => {
      const i = rows.findIndex((x) => x.id === where.id || x.tokenHash === where.tokenHash);
      if (i >= 0) rows.splice(i, 1);
    },
  };
  const sessions = new WebSessionService(ctx.prisma, ctx.box, ctx.oauth, ctx.config);
  return { ...ctx, portal: portal as Portal, rows, sessions };
}

describe('WebSessionService', () => {
  it('starts login on the only portal and on a portal by domain', async () => {
    const { sessions, portal } = await setup();
    const { url, state } = await sessions.start(undefined, 'https://app.example.ru/api/auth/callback');
    const u = new URL(url);
    expect(u.origin).toBe(`https://${portal.domain}`);
    expect(u.pathname).toBe('/oauth/authorize/');
    expect(u.searchParams.get('client_id')).toBe('app.client');
    expect(u.searchParams.get('state')).toBe(state);
    expect(u.searchParams.get('redirect_uri')).toBe('https://app.example.ru/api/auth/callback');
    await expect(sessions.start(`https://${portal.domain.toUpperCase()}/`, 'x')).resolves.toBeTruthy();
    await expect(sessions.start('other.bitrix24.ru', 'x')).rejects.toMatchObject({ response: { code: 'PORTAL_NOT_INSTALLED' } });
  });

  it('redirect uri prefers APP_BASE_URL over the request origin', async () => {
    const { sessions } = await setup();
    expect(sessions.redirectUri('http://evil.example')).toBe('https://app.example.ru/api/auth/callback');
  });

  it('finishes login only with the state from the cookie and the same portal', async () => {
    const { sessions, b24 } = await setup();
    const { state } = await sessions.start(undefined, 'x');
    await expect(sessions.finish({ code: 'c', state }, undefined)).rejects.toMatchObject({ response: { code: 'LOGIN_STATE_MISMATCH' } });
    await expect(sessions.finish({ code: 'c', state }, `${state}x`)).rejects.toMatchObject({ response: { code: 'LOGIN_STATE_MISMATCH' } });
    await expect(sessions.finish({ code: 'c', state, server_domain: 'evil.example' }, state)).rejects.toMatchObject({ code: 'UNTRUSTED_OAUTH_SERVER' });

    const ok = await sessions.finish({ code: 'the-code', state, server_domain: 'oauth.bitrix.info' }, state);
    expect(ok.oauthHost).toBe('oauth.bitrix.info');
    const call = b24.oauthCalls.at(-1)!;
    expect(call.searchParams.get('grant_type')).toBe('authorization_code');
    expect(call.searchParams.get('code')).toBe('the-code');

    b24.oauth = () => ({ body: { access_token: 'a', refresh_token: 'r', expires_in: 3600, member_id: 'another', client_endpoint: CLIENT_ENDPOINT } });
    await expect(sessions.finish({ code: 'c', state }, state)).rejects.toMatchObject({ response: { code: 'LOGIN_MEMBER_MISMATCH' } });
  });

  it('stores only a hash of the cookie secret and encrypted tokens; resolves and refreshes', async () => {
    const { sessions, portal, rows, b24 } = await setup();
    const secret = await sessions.create(portal, { accessToken: 'user-a', refreshToken: 'user-r', expiresAt: new Date(Date.now() + 3600_000), memberId: MEMBER, clientEndpoint: CLIENT_ENDPOINT, serverEndpoint: '', scope: '', userId: 242, status: null }, 'oauth.bitrix.info', { id: 242, name: 'Анна' });
    expect(rows[0].tokenHash).toBe(sha256Hex(secret));
    expect(JSON.stringify(rows[0])).not.toContain('user-a');
    await expect(sessions.resolve(secret)).resolves.toMatchObject({ accessToken: 'user-a' });
    expect(b24.oauthCalls).toHaveLength(0);

    rows[0].accessExpiresAt = new Date(Date.now() + 1000);
    const [a, b] = await Promise.all([sessions.resolve(secret), sessions.resolve(secret)]);
    expect(a.accessToken).toMatch(/^access-/);
    expect(b.accessToken).toBe(a.accessToken);
    expect(b24.oauthCalls).toHaveLength(1);
    expect(b24.oauthCalls[0].searchParams.get('refresh_token')).toBe('user-r');

    await expect(sessions.resolve('wrong')).rejects.toMatchObject({ response: { code: 'SESSION_EXPIRED' } });
    await sessions.destroy(secret);
    await expect(sessions.resolve(secret)).rejects.toMatchObject({ response: { code: 'SESSION_EXPIRED' } });
  });

  it('drops the session when refresh is refused', async () => {
    const { sessions, portal, rows, b24 } = await setup();
    const secret = await sessions.create(portal, { accessToken: 'a', refreshToken: 'r', expiresAt: new Date(0), memberId: MEMBER, clientEndpoint: CLIENT_ENDPOINT, serverEndpoint: '', scope: '', userId: 1, status: null }, 'oauth.bitrix.info', { id: 1, name: 'x' });
    b24.oauth = () => ({ status: 401, body: { error: 'invalid_grant' } });
    await expect(sessions.resolve(secret)).rejects.toMatchObject({ response: { code: 'SESSION_EXPIRED' } });
    expect(rows).toHaveLength(0);
  });
});

describe('WebSessionService.resolve — sliding expiry', () => {
  it('a write conflict while extending does not fail the request', async () => {
    const { sessions, portal, rows } = await setup();
    const secret = await sessions.create(portal, { accessToken: 'user-a', refreshToken: 'r', expiresAt: new Date(Date.now() + 3600_000), memberId: MEMBER, clientEndpoint: CLIENT_ENDPOINT, serverEndpoint: '', scope: '', userId: 242, status: null }, 'oauth.bitrix.info', { id: 242, name: 'Анна' });
    rows[0]!.lastSeenAt = new Date(Date.now() - 2 * 3600_000);
    const prisma = (sessions as unknown as { prisma: { webSession: Record<string, unknown> } }).prisma;
    prisma.webSession.updateMany = async () => {
      throw new Error("Record has changed since last read in table 'WebSession'");
    };
    await expect(sessions.resolve(secret)).resolves.toMatchObject({ accessToken: 'user-a' });
  });
});

describe('B24AuthGuard with a web session', () => {
  it('accepts the session cookie only with the standalone header', async () => {
    const { sessions, portal, service } = await setup();
    const secret = await sessions.create(portal, { accessToken: 'user-a', refreshToken: 'r', expiresAt: new Date(Date.now() + 3600_000), memberId: MEMBER, clientEndpoint: CLIENT_ENDPOINT, serverEndpoint: '', scope: '', userId: 242, status: null }, 'oauth.bitrix.info', { id: 242, name: 'Анна' });
    const verifier = new UserTokenVerifier(service);
    const verify = vi.spyOn(verifier, 'verify').mockResolvedValue({ userId: 242 } as never);
    const guard = new B24AuthGuard(verifier, sessions);
    const run = (headers: Record<string, string>) => {
      const req: Record<string, unknown> = { headers };
      return guard.canActivate({ switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext).then(() => req);
    };
    await expect(run({ cookie: `btx24_session=${secret}` })).rejects.toMatchObject({ response: { code: 'UNAUTHORIZED' } });
    await expect(run({ cookie: `a=1; btx24_session=${secret}`, 'x-btx24-standalone': '1' })).resolves.toMatchObject({ b24: { userId: 242 } });
    expect(verify).toHaveBeenCalledWith(MEMBER, 'user-a');
  });
});

describe('readCookie', () => {
  it('finds a cookie by exact name', () => {
    expect(readCookie('x_btx24_session=1; btx24_session=abc', 'btx24_session')).toBe('abc');
    expect(readCookie(undefined, 'btx24_session')).toBeUndefined();
  });
});
