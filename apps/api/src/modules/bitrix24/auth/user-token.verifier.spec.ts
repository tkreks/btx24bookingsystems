import { UserTokenVerifier } from './user-token.verifier.js';
import { B24AuthGuard } from './b24-auth.guard.js';
import { makePortalService, MEMBER, CLIENT_ENDPOINT } from '../testing/fakes.js';
import type { ExecutionContext } from '@nestjs/common';

async function setup() {
  const ctx = makePortalService();
  await ctx.service.saveInstallation(
    { accessToken: 'app-a', refreshToken: 'app-r', expiresAt: new Date(Date.now() + 3600_000), memberId: MEMBER, clientEndpoint: CLIENT_ENDPOINT, serverEndpoint: 'https://oauth.bitrix.info/rest/', scope: '', userId: 1, status: 'L' },
    'app-token',
  );
  ctx.b24.rest['user.current'] = (body: Record<string, unknown>) =>
    body.auth === 'user-token' ? { result: { ID: '242', NAME: 'Анна', LAST_NAME: 'Петрова' } } : body.auth === 'old-token' ? { error: 'expired_token' } : { error: 'NO_AUTH_FOUND' };
  ctx.b24.rest['user.admin'] = { result: false };
  return { ...ctx, verifier: new UserTokenVerifier(ctx.service) };
}

describe('UserTokenVerifier', () => {
  it('resolves portal + user via user.current on the registered portal endpoint', async () => {
    const { verifier, b24 } = await setup();
    const u = await verifier.verify(MEMBER, 'user-token');
    expect(u).toMatchObject({ userId: 242, userName: 'Анна Петрова', isAdmin: false });
    expect(b24.restCalls.every((c) => c.body.auth === 'user-token')).toBe(true);
  });

  it('caches a verified token for a while', async () => {
    const { verifier, b24 } = await setup();
    await verifier.verify(MEMBER, 'user-token');
    const before = b24.restCalls.length;
    await verifier.verify(MEMBER, 'user-token');
    expect(b24.restCalls.length).toBe(before);
  });

  it('distinguishes an expired token (refreshable) from an invalid one', async () => {
    const { verifier } = await setup();
    await expect(verifier.verify(MEMBER, 'old-token')).rejects.toMatchObject({ response: { code: 'TOKEN_EXPIRED' }, status: 401 });
    await expect(verifier.verify(MEMBER, 'garbage')).rejects.toMatchObject({ response: { code: 'INVALID_TOKEN' } });
  });

  it('rejects unknown portals without calling Bitrix24', async () => {
    const { verifier, b24 } = await setup();
    await expect(verifier.verify('unknown-member', 'user-token')).rejects.toMatchObject({ response: { code: 'PORTAL_NOT_INSTALLED' } });
    expect(b24.restCalls).toHaveLength(0);
  });

  it('user client honours read-only mode', async () => {
    const ctx = makePortalService({ config: { readOnly: true } });
    await ctx.service.saveInstallation(
      { accessToken: 'a', refreshToken: 'r', expiresAt: new Date(Date.now() + 3600_000), memberId: MEMBER, clientEndpoint: CLIENT_ENDPOINT, serverEndpoint: 'https://oauth.bitrix.info/rest/', scope: '', userId: 1, status: 'L' },
      't',
    );
    ctx.b24.rest['user.current'] = { result: { ID: '1' } };
    ctx.b24.rest['user.admin'] = { result: true };
    const u = await new UserTokenVerifier(ctx.service).verify(MEMBER, 'tok');
    await expect(u.client.call('crm.deal.update', { id: 1 })).rejects.toMatchObject({ code: 'READ_ONLY_MODE' });
  });
});

describe('B24AuthGuard', () => {
  const ctxFor = (headers: Record<string, string>) => {
    const req: Record<string, unknown> = { headers };
    return { req, ctx: { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext };
  };

  it('requires Bearer token and a sane member id', async () => {
    const { verifier } = await setup();
    const guard = new B24AuthGuard(verifier);
    await expect(guard.canActivate(ctxFor({}).ctx)).rejects.toMatchObject({ response: { code: 'UNAUTHORIZED' } });
    await expect(guard.canActivate(ctxFor({ authorization: 'Bearer user-token', 'x-b24-member-id': '../../x' }).ctx)).rejects.toMatchObject({ response: { code: 'UNAUTHORIZED' } });
  });

  it('attaches the user context to the request', async () => {
    const { verifier } = await setup();
    const { req, ctx } = ctxFor({ authorization: 'Bearer user-token', 'x-b24-member-id': 'memberabc123' });
    // Верификацию проверяют тесты UserTokenVerifier; здесь — только что guard кладёт контекст в запрос.
    vi.spyOn(verifier, 'verify').mockResolvedValue({ userId: 242 } as never);
    await expect(new B24AuthGuard(verifier).canActivate(ctx)).resolves.toBe(true);
    expect(req.b24).toMatchObject({ userId: 242 });
  });
});
