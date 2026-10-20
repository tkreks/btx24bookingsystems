import { OAuthClient, trustedOAuthHost } from './oauth.client.js';
import { fakeBitrix } from '../testing/fakes.js';

describe('trustedOAuthHost', () => {
  it('accepts only https endpoints from the allow-list', () => {
    expect(trustedOAuthHost('https://oauth.bitrix.info/rest/', ['oauth.bitrix.info'])).toBe('oauth.bitrix.info');
    expect(() => trustedOAuthHost('https://evil.example/rest/', ['oauth.bitrix.info'])).toThrow(/not in B24_TRUSTED_OAUTH_HOSTS/);
    expect(() => trustedOAuthHost('http://oauth.bitrix.info/rest/', ['oauth.bitrix.info'])).toThrow();
    expect(() => trustedOAuthHost('not a url', ['oauth.bitrix.info'])).toThrow(/valid URL/);
  });
});

describe('OAuthClient.refresh', () => {
  it('exchanges the refresh token and returns trusted portal data', async () => {
    const b24 = fakeBitrix();
    const tokens = await new OAuthClient('app.id', 'app.secret', b24.fetch).refresh('oauth.bitrix.info', 'r-0');
    expect(tokens).toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-1', memberId: 'member-abc', userId: 1 });
    expect(tokens.expiresAt.getTime()).toBeGreaterThan(Date.now());
    const q = b24.oauthCalls[0].searchParams;
    expect([q.get('grant_type'), q.get('client_id'), q.get('client_secret'), q.get('refresh_token')]).toEqual(['refresh_token', 'app.id', 'app.secret', 'r-0']);
  });

  it('surfaces authorization server errors', async () => {
    const b24 = fakeBitrix();
    b24.oauth = () => ({ status: 401, body: { error: 'invalid_grant', error_description: 'Invalid grant' } });
    await expect(new OAuthClient('a', 'b', b24.fetch).refresh('oauth.bitrix.info', 'x')).rejects.toMatchObject({ code: 'invalid_grant' });
  });

  it('refuses to run without client credentials', async () => {
    await expect(new OAuthClient(undefined, undefined).refresh('oauth.bitrix.info', 'x')).rejects.toMatchObject({ code: 'APP_NOT_CONFIGURED' });
  });
});
