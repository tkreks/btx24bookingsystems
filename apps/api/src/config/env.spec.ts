import { validateEnv } from './env.js';

describe('validateEnv', () => {
  const base = { DATABASE_URL: 'postgresql://u:p@db:5432/x' };

  it('treats empty optional vars (as passed by docker compose) as unset', () => {
    const env = validateEnv({ ...base, APP_BASE_URL: '' });
    expect(env.APP_BASE_URL).toBeUndefined();
  });

  it('still rejects a malformed APP_BASE_URL', () => {
    expect(() => validateEnv({ ...base, APP_BASE_URL: 'not a url' })).toThrow(/APP_BASE_URL/);
  });

  it('requires DATABASE_URL', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
  });
});
