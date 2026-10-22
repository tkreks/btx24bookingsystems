import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Portal } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { B24_CONFIG, type Bitrix24Config } from '../bitrix24.tokens.js';
import { SecretBox, sha256Hex } from '../crypto/secret-box.js';
import { OAuthClient, trustedOAuthHost, type TokenSet } from '../oauth/oauth.client.js';
import { Bitrix24Error } from '../rest/errors.js';
import { AuthError } from './user-token.verifier.js';

/** Cookie сессии входа вне портала и cookie проверки возврата с портала (`state`). */
export const SESSION_COOKIE = 'btx24_session';
export const STATE_COOKIE = 'btx24_login';
/** Сессия живёт 30 дней с последнего захода; токены обновляются по refresh_token. */
export const SESSION_TTL_MS = 30 * 24 * 3600_000;
const REFRESH_AHEAD_MS = 60_000;

/**
 * Вход в приложение напрямую, не из фрейма портала (решение владельца 2026-10-22): OAuth Битрикс24 —
 * портал подтверждает сотрудника и возвращает одноразовый код, сервер меняет его на токены
 * сотрудника и хранит их зашифрованными (`WebSession`). В браузере — только cookie со случайным
 * секретом (HttpOnly). Дальше всё как во фрейме: токен сотрудника, его права в CRM.
 */
@Injectable()
export class WebSessionService {
  private readonly logger = new Logger(WebSessionService.name);
  /** Сессия → идущее обновление токенов (параллельные запросы ждут одно). */
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly box: SecretBox,
    private readonly oauth: OAuthClient,
    @Inject(B24_CONFIG) private readonly config: Bitrix24Config,
  ) {}

  /** Адрес, куда портал вернёт сотрудника: APP_BASE_URL, иначе адрес, с которого пришли. */
  redirectUri(requestOrigin: string): string {
    return `${(this.config.appBaseUrl ?? requestOrigin).replace(/\/+$/, '')}/api/auth/callback`;
  }

  /**
   * Начало входа: портал по домену (без домена — если портал один), адрес страницы входа портала
   * и `state` (кладётся в cookie, портал вернёт его — так ответ не подделать чужой ссылкой).
   */
  async start(domain: string | undefined, redirectUri: string): Promise<{ url: string; state: string }> {
    const portals = await this.prisma.portal.findMany({ where: { status: 'ACTIVE' } });
    const want = (domain ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const portal = want ? portals.find((p) => p.domain.toLowerCase() === want) : portals.length === 1 ? portals[0] : undefined;
    if (!portal) throw new AuthError('PORTAL_NOT_INSTALLED', want ? `Приложение не установлено на портале ${want}` : 'Укажите адрес вашего Битрикс24');
    const state = `${portal.id}.${randomBytes(24).toString('hex')}`;
    return { url: this.oauth.authorizeUrl(portal.domain, state, redirectUri), state };
  }

  /**
   * Возврат с портала: `state` совпадает с cookie, код меняется на токены на доверенном сервере
   * авторизации, портал — тот же, что начинал вход.
   */
  async finish(q: { code?: unknown; state?: unknown; server_domain?: unknown }, stateCookie: string | undefined): Promise<{ portal: Portal; tokens: TokenSet; oauthHost: string }> {
    const state = typeof q.state === 'string' ? q.state : '';
    if (!state || !stateCookie || !safeEqual(state, stateCookie)) throw new AuthError('LOGIN_STATE_MISMATCH', 'Вход устарел — начните заново');
    if (typeof q.code !== 'string' || !q.code) throw new AuthError('LOGIN_NO_CODE', 'Портал не подтвердил вход');
    const portal = await this.prisma.portal.findFirst({ where: { id: state.split('.')[0], status: 'ACTIVE' } });
    if (!portal) throw new AuthError('PORTAL_NOT_INSTALLED', 'Приложение не установлено на этом портале');
    const server = typeof q.server_domain === 'string' && q.server_domain ? `https://${q.server_domain}/` : portal.serverEndpoint;
    const oauthHost = trustedOAuthHost(server, this.config.trustedOAuthHosts);
    const tokens = await this.oauth.exchangeCode(oauthHost, q.code);
    if (tokens.memberId !== portal.memberId) throw new AuthError('LOGIN_MEMBER_MISMATCH', 'Вход подтвердил другой портал');
    return { portal, tokens, oauthHost };
  }

  /** Новая сессия: в cookie — случайный секрет, в базе — его хеш и зашифрованные токены. */
  async create(portal: Portal, tokens: TokenSet, oauthHost: string, user: { id: number; name: string }): Promise<string> {
    const secret = randomBytes(32).toString('hex');
    await this.prisma.webSession.create({
      data: {
        portalId: portal.id,
        tokenHash: sha256Hex(secret),
        userId: user.id,
        userName: user.name.slice(0, 255),
        accessTokenEnc: this.box.encrypt(tokens.accessToken),
        refreshTokenEnc: this.box.encrypt(tokens.refreshToken),
        accessExpiresAt: tokens.expiresAt,
        oauthHost,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      },
    });
    return secret;
  }

  /** Сессия по cookie → портал и живой токен сотрудника (обновляется заранее); нет или истекла — ошибка входа. */
  async resolve(secret: string): Promise<{ portal: Portal; accessToken: string }> {
    const s = await this.prisma.webSession.findUnique({ where: { tokenHash: sha256Hex(secret) }, include: { portal: true } });
    if (!s || s.expiresAt.getTime() < Date.now() || s.portal.status !== 'ACTIVE') throw new AuthError('SESSION_EXPIRED', 'Сессия входа истекла — войдите снова');
    let accessToken = this.box.decrypt(s.accessTokenEnc);
    if (s.accessExpiresAt.getTime() - Date.now() < REFRESH_AHEAD_MS) {
      const running = this.inflight.get(s.id) ?? this.refresh(s.id, s.oauthHost, this.box.decrypt(s.refreshTokenEnc), s.portal.memberId).finally(() => this.inflight.delete(s.id));
      this.inflight.set(s.id, running);
      accessToken = await running;
    }
    // Скользящий срок: заходил сегодня — сессия продлевается (запись не чаще раза в час).
    if (Date.now() - s.lastSeenAt.getTime() > 3600_000)
      await this.prisma.webSession.update({ where: { id: s.id }, data: { lastSeenAt: new Date(), expiresAt: new Date(Date.now() + SESSION_TTL_MS) } });
    return { portal: s.portal, accessToken };
  }

  async destroy(secret: string): Promise<void> {
    await this.prisma.webSession.deleteMany({ where: { tokenHash: sha256Hex(secret) } });
  }

  private async refresh(sessionId: string, oauthHost: string, refreshToken: string, memberId: string): Promise<string> {
    let tokens: TokenSet;
    try {
      tokens = await this.oauth.refresh(oauthHost, refreshToken);
    } catch (err) {
      this.logger.warn(`web session ${sessionId}: refresh failed (${err instanceof Bitrix24Error ? err.code : String(err)})`);
      await this.prisma.webSession.deleteMany({ where: { id: sessionId } });
      throw new AuthError('SESSION_EXPIRED', 'Сессия входа истекла — войдите снова');
    }
    if (tokens.memberId !== memberId) throw new AuthError('LOGIN_MEMBER_MISMATCH', 'Сервер авторизации вернул другой портал');
    await this.prisma.webSession.update({
      where: { id: sessionId },
      data: { accessTokenEnc: this.box.encrypt(tokens.accessToken), refreshTokenEnc: this.box.encrypt(tokens.refreshToken), accessExpiresAt: tokens.expiresAt },
    });
    return tokens.accessToken;
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Значение cookie из заголовка `Cookie` (без сторонних парсеров). */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}
