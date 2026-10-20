import { hashPassword, verifyPassword } from './password.js';

describe('password hashing', () => {
  it('hashes with a random salt and verifies', async () => {
    const a = await hashPassword('secret-1');
    const b = await hashPassword('secret-1');
    expect(a).not.toBe(b);
    expect(a.startsWith('scrypt$16384$8$1$')).toBe(true);
    expect(a).not.toContain('secret-1');
    await expect(verifyPassword('secret-1', a)).resolves.toBe(true);
    await expect(verifyPassword('secret-2', a)).resolves.toBe(false);
  });

  it('rejects malformed hashes', async () => {
    await expect(verifyPassword('x', 'plain-text')).resolves.toBe(false);
  });
});
