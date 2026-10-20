import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';

/**
 * Шифрование секретов портала (OAuth-токены) в БД: AES-256-GCM, формат `v1:<iv>:<tag>:<data>`
 * (base64url). Префикс версии оставлен под будущую ротацию ключа.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, 'base64');
    if (this.key.length !== 32) throw new Error('SecretBox key must be 32 bytes');
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [VERSION, iv, cipher.getAuthTag(), data].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join(':');
  }

  decrypt(sealed: string): string {
    const [version, iv, tag, data] = sealed.split(':');
    if (version !== VERSION || !iv || !tag || data === undefined) throw new Error('Unsupported secret format');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  }
}

/** sha256 в hex — для секретов, которые нужно только сравнивать (application_token). */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Сравнение секрета с сохранённым хешем без утечки по времени. */
export function matchesHash(value: string, expectedHex: string | null | undefined): boolean {
  if (!expectedHex) return false;
  const a = Buffer.from(sha256Hex(value), 'hex');
  const b = Buffer.from(expectedHex, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
