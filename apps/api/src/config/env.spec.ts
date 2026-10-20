import { validateEnv } from './env.js';

describe('validateEnv', () => {
  const base = { DATABASE_URL: 'mysql://u:p@db:3306/x', ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') };

  it('treats empty optional vars (as passed by docker compose) as unset', () => {
    const env = validateEnv({ ...base, APP_BASE_URL: '' });
    expect(env.APP_BASE_URL).toBeUndefined();
  });

  it('still rejects a malformed APP_BASE_URL', () => {
    expect(() => validateEnv({ ...base, APP_BASE_URL: 'not a url' })).toThrow(/APP_BASE_URL/);
  });

  it('requires DATABASE_URL and a 32-byte ENCRYPTION_KEY', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
    expect(() => validateEnv({ ...base, ENCRYPTION_KEY: 'c2hvcnQ=' })).toThrow(/ENCRYPTION_KEY/);
  });

  it('parses the trusted OAuth host list', () => {
    expect(validateEnv({ ...base, B24_TRUSTED_OAUTH_HOSTS: 'oauth.bitrix.info, Box.Example.ru' }).B24_TRUSTED_OAUTH_HOSTS).toEqual([
      'oauth.bitrix.info',
      'box.example.ru',
    ]);
  });
});
