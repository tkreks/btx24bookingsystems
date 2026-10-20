import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Portal } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { SecretBox, sha256Hex } from '../crypto/secret-box.js';
import { OAuthClient, type TokenSet, trustedOAuthHost } from '../oauth/oauth.client.js';
import { Bitrix24Error, REAUTH_CODES } from '../rest/errors.js';
import { RateLimiter } from '../rest/rate-limiter.js';
import { Bitrix24RestClient, type AccessProvider, type WritePolicy } from '../rest/rest-client.js';
import { SandboxWritePolicy } from '../sandbox/sandbox.policy.js';
import { B24_CONFIG, B24_FETCH, type Bitrix24Config } from '../bitrix24.tokens.js';

/** Обновляем access-токен заранее, чтобы запрос не упёрся в `expired_token`. */
const REFRESH_AHEAD_MS = 60_000;

/**
 * Порталы (тенанты) и их OAuth-токены приложения. Токены выдаются пользователю, установившему
 * приложение (администратору), — ими пользуются фоновые задачи. Запросы от имени текущего
 * пользователя идут с его собственным токеном (модуль авторизации, отдельная задача).
 */
@Injectable()
export class PortalService {
  private readonly logger = new Logger(PortalService.name);
  /** Один refresh на портал в пределах процесса; между процессами защищает перечитывание из БД. */
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly box: SecretBox,
    private readonly oauth: OAuthClient,
    private readonly limiter: RateLimiter,
    @Inject(B24_CONFIG) private readonly config: Bitrix24Config,
    @Inject(B24_FETCH) private readonly fetchImpl: typeof fetch,
  ) {}

  findActiveByMemberId(memberId: string): Promise<Portal | null> {
    return this.prisma.portal.findFirst({ where: { memberId, status: 'ACTIVE' } });
  }

  /** Сохраняет установку: токены — зашифрованы, application_token — хешем. */
  saveInstallation(tokens: TokenSet, applicationToken: string): Promise<Portal> {
    const data = {
      domain: new URL(tokens.clientEndpoint).hostname,
      clientEndpoint: tokens.clientEndpoint,
      serverEndpoint: tokens.serverEndpoint,
      applicationTokenHash: sha256Hex(applicationToken),
      accessTokenEnc: this.box.encrypt(tokens.accessToken),
      refreshTokenEnc: this.box.encrypt(tokens.refreshToken),
      accessExpiresAt: tokens.expiresAt,
      scope: tokens.scope,
      status: 'ACTIVE' as const,
      installedByUserId: tokens.userId,
      installedAt: new Date(),
      uninstalledAt: null,
    };
    return this.prisma.portal.upsert({ where: { memberId: tokens.memberId }, create: { memberId: tokens.memberId, ...data }, update: data });
  }

  /** Фактические права приложения (ответ `oauth/token` для локальных приложений даёт лишь `app`). */
  async updateScope(portalId: string, scope: string[]): Promise<void> {
    await this.prisma.portal.update({ where: { id: portalId }, data: { scope: scope.join(',').slice(0, 1000) } });
  }

  /** Удаление приложения с портала: токены стираем сразу, данные портала оставляем. */
  async markUninstalled(portalId: string): Promise<void> {
    await this.prisma.portal.update({
      where: { id: portalId },
      data: { status: 'UNINSTALLED', uninstalledAt: new Date(), accessTokenEnc: null, refreshTokenEnc: null, accessExpiresAt: null },
    });
  }

  /** REST-клиент портала с токеном приложения. */
  clientFor(portal: Portal): Bitrix24RestClient {
    const access: AccessProvider = {
      getAccessToken: () => this.currentAccessToken(portal.id),
      refresh: (expired) => this.refreshTokens(portal.id, expired),
    };
    return new Bitrix24RestClient({ clientEndpoint: portal.clientEndpoint, access, limiter: this.limiter, limiterKey: portal.memberId, fetch: this.fetchImpl, readOnly: this.config.readOnly, writePolicy: this.policyFor(portal) });
  }

  /**
   * Клиент на произвольном токене: токен пользователя (передаётся `portal` — действует песочница)
   * или токен сразу после установки, до сохранения портала.
   */
  clientWithToken(clientEndpoint: string, memberId: string, accessToken: string, portal?: Portal): Bitrix24RestClient {
    const access: AccessProvider = {
      getAccessToken: async () => accessToken,
      refresh: async () => {
        throw new Bitrix24Error('expired_token', 'Token cannot be refreshed in this context');
      },
    };
    return new Bitrix24RestClient({ clientEndpoint, access, limiter: this.limiter, limiterKey: memberId, fetch: this.fetchImpl, readOnly: this.config.readOnly, writePolicy: portal ? this.policyFor(portal) : undefined });
  }

  private policyFor(portal: Portal): WritePolicy | undefined {
    return this.config.readOnly && this.config.sandbox ? new SandboxWritePolicy(this.prisma, portal, this.config.sandbox) : undefined;
  }

  private async currentAccessToken(portalId: string): Promise<string> {
    const p = await this.load(portalId);
    if (p.accessTokenEnc && p.accessExpiresAt && p.accessExpiresAt.getTime() - Date.now() > REFRESH_AHEAD_MS) {
      return this.box.decrypt(p.accessTokenEnc);
    }
    return this.refreshTokens(portalId, p.accessTokenEnc ? this.box.decrypt(p.accessTokenEnc) : '');
  }

  private refreshTokens(portalId: string, expiredToken: string): Promise<string> {
    const running = this.inflight.get(portalId);
    if (running) return running;
    const job = this.doRefresh(portalId, expiredToken).finally(() => this.inflight.delete(portalId));
    this.inflight.set(portalId, job);
    return job;
  }

  private async doRefresh(portalId: string, expiredToken: string): Promise<string> {
    const p = await this.load(portalId);
    // Другой процесс (api/worker) уже обновил токены — берём их, второй обмен сжёг бы refresh_token.
    const fresh = this.freshTokenIfChanged(p, expiredToken);
    if (fresh) return fresh;
    if (!p.refreshTokenEnc) throw new Bitrix24Error('REAUTH_REQUIRED', 'Portal has no refresh token — reinstall the application');

    const host = trustedOAuthHost(p.serverEndpoint, this.config.trustedOAuthHosts);
    let tokens: TokenSet;
    try {
      tokens = await this.oauth.refresh(host, this.box.decrypt(p.refreshTokenEnc));
    } catch (err) {
      if (err instanceof Bitrix24Error && REAUTH_CODES.has(err.code)) {
        const again = this.freshTokenIfChanged(await this.load(portalId), expiredToken);
        if (again) return again;
        this.logger.warn(`portal ${p.memberId}: refresh rejected (${err.code}) — reinstall required`);
        throw new Bitrix24Error('REAUTH_REQUIRED', 'Refresh token rejected — reinstall the application', err.httpStatus);
      }
      throw err;
    }
    if (tokens.memberId !== p.memberId) throw new Bitrix24Error('MEMBER_MISMATCH', 'Authorization server returned another portal');
    await this.prisma.portal.update({
      where: { id: portalId },
      data: {
        accessTokenEnc: this.box.encrypt(tokens.accessToken),
        refreshTokenEnc: this.box.encrypt(tokens.refreshToken),
        accessExpiresAt: tokens.expiresAt,
        clientEndpoint: tokens.clientEndpoint,
        scope: tokens.scope,
      },
    });
    return tokens.accessToken;
  }

  private freshTokenIfChanged(p: Portal, expiredToken: string): string | null {
    if (!p.accessTokenEnc || !p.accessExpiresAt) return null;
    const current = this.box.decrypt(p.accessTokenEnc);
    return current !== expiredToken && p.accessExpiresAt.getTime() - Date.now() > REFRESH_AHEAD_MS ? current : null;
  }

  private async load(portalId: string): Promise<Portal> {
    const p = await this.prisma.portal.findUnique({ where: { id: portalId } });
    if (!p || p.status !== 'ACTIVE') throw new Bitrix24Error('PORTAL_INACTIVE', 'Portal is not installed');
    return p;
  }
}
