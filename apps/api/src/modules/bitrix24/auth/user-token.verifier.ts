import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { sha256Hex } from '../crypto/secret-box.js';
import { PortalService } from '../portals/portal.service.js';
import { Bitrix24Error, REAUTH_CODES, TOKEN_EXPIRED_CODES } from '../rest/errors.js';
import type { B24UserContext } from './user-context.js';

const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX = 1000;

type Verified = { userId: number; userName: string; isAdmin: boolean; departmentIds: number[] };

/** 401 с кодом, по которому интерфейс решает: обновить токен (TOKEN_EXPIRED) или показать ошибку. */
export class AuthError extends HttpException {
  constructor(code: string, message: string) {
    super({ code, message }, HttpStatus.UNAUTHORIZED);
  }
}

/**
 * Проверка токена пользователя из фрейма: запрос `user.current` идёт на endpoint УЖЕ
 * зарегистрированного портала (по member_id), поэтому токен другого портала не пройдёт.
 * Результат кэшируется по хешу токена на 5 минут — не дёргаем портал на каждый запрос.
 */
@Injectable()
export class UserTokenVerifier {
  private readonly cache = new Map<string, { value: Verified; expiresAt: number }>();
  /** Проверки в полёте: пачка запросов страницы с новым токеном — один user.current/user.admin. */
  private readonly inflight = new Map<string, Promise<Verified>>();

  constructor(private readonly portals: PortalService) {}

  async verify(memberId: string, token: string): Promise<B24UserContext> {
    const portal = await this.portals.findActiveByMemberId(memberId);
    if (!portal) throw new AuthError('PORTAL_NOT_INSTALLED', 'Приложение не установлено на этом портале');
    const client = this.portals.clientWithToken(portal.clientEndpoint, portal.memberId, token, portal);

    const key = sha256Hex(`${memberId}:${token}`);
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > Date.now()) {
      // Сбои запросов этого клиента в журнале — от имени сотрудника.
      client.actor = { userId: hit.value.userId, name: hit.value.userName };
      return { portal, client, ...hit.value };
    }

    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.check(client).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    const value = await pending;
    this.remember(key, value);
    client.actor = { userId: value.userId, name: value.userName };
    return { portal, client, ...value };
  }

  private async check(client: ReturnType<PortalService['clientWithToken']>): Promise<Verified> {
    let value: Verified;
    try {
      // Два вызова, а не batch: user.current может быть запрещён в пакете (ERROR_BATCH_METHOD_NOT_ALLOWED).
      const u = (await client.call<{ ID?: string | number; NAME?: string; LAST_NAME?: string; UF_DEPARTMENT?: (string | number)[] }>('user.current')).result;
      if (!u?.ID) throw new Bitrix24Error('NO_AUTH_FOUND', 'user.current returned no user');
      const admin = (await client.call<boolean>('user.admin')).result === true;
      value = {
        userId: Number(u.ID),
        userName: [u.NAME, u.LAST_NAME].filter(Boolean).join(' ').trim() || `#${u.ID}`,
        isAdmin: admin,
        departmentIds: (Array.isArray(u.UF_DEPARTMENT) ? u.UF_DEPARTMENT : []).map(Number).filter(Number.isFinite),
      };
    } catch (err) {
      if (err instanceof Bitrix24Error && (TOKEN_EXPIRED_CODES.has(err.code) || REAUTH_CODES.has(err.code))) {
        throw TOKEN_EXPIRED_CODES.has(err.code)
          ? new AuthError('TOKEN_EXPIRED', 'Токен Битрикс24 истёк — обновите авторизацию')
          : new AuthError('INVALID_TOKEN', 'Токен Битрикс24 недействителен');
      }
      throw err;
    }
    return value;
  }

  private remember(key: string, value: Verified) {
    if (this.cache.size >= CACHE_MAX) {
      const now = Date.now();
      for (const [k, v] of this.cache) if (v.expiresAt <= now) this.cache.delete(k);
      if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string);
    }
    this.cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }
}
