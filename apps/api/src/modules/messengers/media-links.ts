import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { B24_CONFIG, type Bitrix24Config } from '../bitrix24/bitrix24.tokens.js';

/** Ссылка на вложение для Битрикс24 живёт сутки (линия скачивает файл сразу). */
export const MEDIA_LINK_TTL_S = 24 * 3600;

/**
 * Публичные ссылки на вложения переписки — для своей открытой линии: `imconnector.send.messages`
 * принимает файлы только ссылкой, и Битрикс24 скачивает их без входа в приложение. Ссылка подписана
 * (HMAC от ключа шифрования) и ограничена по времени: угадать или продлить её нельзя.
 */
@Injectable()
export class MediaLinks {
  private readonly key: Buffer;

  constructor(
    config: ConfigService<Env, true>,
    @Inject(B24_CONFIG) private readonly b24: Bitrix24Config,
  ) {
    this.key = createHmac('sha256', Buffer.from(config.get('ENCRYPTION_KEY', { infer: true }), 'base64')).update('messenger-media').digest();
  }

  private sig(messengerId: string, fileId: string, exp: number): string {
    return createHmac('sha256', this.key).update(`${messengerId}/${fileId}/${exp}`).digest('base64url');
  }

  url(messengerId: string, fileId: string, now = Date.now()): string | null {
    const base = this.b24.appBaseUrl?.replace(/\/$/, '');
    if (!base) return null;
    const exp = Math.floor(now / 1000) + MEDIA_LINK_TTL_S;
    return `${base}/api/messengers/files/${messengerId}/${fileId}?exp=${exp}&sig=${this.sig(messengerId, fileId, exp)}`;
  }

  valid(messengerId: string, fileId: string, exp: unknown, sig: unknown, now = Date.now()): boolean {
    const e = Number(exp);
    if (!Number.isSafeInteger(e) || e * 1000 <= now || e > Math.floor(now / 1000) + MEDIA_LINK_TTL_S || typeof sig !== 'string') return false;
    const a = Buffer.from(this.sig(messengerId, fileId, e));
    const b = Buffer.from(sig);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
