import { SecretBox, matchesHash, sha256Hex } from './secret-box.js';

const key = Buffer.alloc(32, 7).toString('base64');

describe('SecretBox', () => {
  it('round-trips and uses a fresh IV every time', () => {
    const box = new SecretBox(key);
    const a = box.encrypt('token-123');
    const b = box.encrypt('token-123');
    expect(a).not.toBe(b);
    expect(a.startsWith('v1:')).toBe(true);
    expect(box.decrypt(a)).toBe('token-123');
  });

  it('rejects tampered ciphertext and a wrong key', () => {
    const box = new SecretBox(key);
    const sealed = box.encrypt('secret');
    const parts = sealed.split(':');
    parts[3] = Buffer.from('other').toString('base64url');
    expect(() => box.decrypt(parts.join(':'))).toThrow();
    expect(() => new SecretBox(Buffer.alloc(32, 8).toString('base64')).decrypt(sealed)).toThrow();
  });

  it('refuses keys that are not 32 bytes', () => {
    expect(() => new SecretBox(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
  });
});

describe('matchesHash', () => {
  it('compares a secret with its stored sha256', () => {
    const stored = sha256Hex('app-token');
    expect(matchesHash('app-token', stored)).toBe(true);
    expect(matchesHash('other', stored)).toBe(false);
    expect(matchesHash('app-token', null)).toBe(false);
  });
});
