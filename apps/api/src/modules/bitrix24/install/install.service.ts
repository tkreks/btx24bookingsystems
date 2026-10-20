import { Inject, Injectable, Logger } from '@nestjs/common';
import { OAuthClient, trustedOAuthHost } from '../oauth/oauth.client.js';
import { PortalService } from '../portals/portal.service.js';
import { Bitrix24Error } from '../rest/errors.js';
import { B24_CONFIG, type Bitrix24Config } from '../bitrix24.tokens.js';

/** Поля, которые портал присылает в обработчик установки (query + тело POST). */
export interface InstallRequest {
  DOMAIN?: string;
  AUTH_ID?: string;
  REFRESH_ID?: string;
  SERVER_ENDPOINT?: string;
  APPLICATION_TOKEN?: string;
  member_id?: string;
}

/** Тело события ONAPPINSTALL (режим «Приложение само завершает установку»). */
export interface InstallEvent {
  event?: string;
  auth?: { refresh_token?: string; server_endpoint?: string; application_token?: string; member_id?: string; domain?: string };
}

/** Облачный сервер авторизации — если портал не прислал SERVER_ENDPOINT. */
export const DEFAULT_SERVER_ENDPOINT = 'https://oauth.bitrix.info/rest/';

/**
 * Приводит оба варианта установки к одному виду: форма мастера установки (AUTH_ID/REFRESH_ID/…)
 * или событие ONAPPINSTALL (auth[refresh_token]/…). Доверия это не добавляет — всё проверяется
 * обменом refresh-токена на сервере авторизации.
 */
export function normalizeInstallRequest(input: InstallRequest & InstallEvent): InstallRequest {
  if (String(input.event ?? '').toUpperCase() === 'ONAPPINSTALL' && input.auth) {
    const a = input.auth;
    return { REFRESH_ID: a.refresh_token, SERVER_ENDPOINT: a.server_endpoint ?? DEFAULT_SERVER_ENDPOINT, APPLICATION_TOKEN: a.application_token, member_id: a.member_id, DOMAIN: a.domain };
  }
  return { ...input, SERVER_ENDPOINT: input.SERVER_ENDPOINT || DEFAULT_SERVER_ENDPOINT };
}

/** События, на которые приложение подписывается при установке. */
export const BOUND_EVENTS = ['ONAPPUNINSTALL'] as const;

@Injectable()
export class InstallService {
  private readonly logger = new Logger(InstallService.name);

  constructor(
    private readonly portals: PortalService,
    private readonly oauth: OAuthClient,
    @Inject(B24_CONFIG) private readonly config: Bitrix24Config,
  ) {}

  /**
   * Установка: POST от портала подделать можно, поэтому всё, что сохраняем, берём из ответа
   * сервера авторизации на обмен REFRESH_ID (нужен client_secret, его знаем только мы).
   */
  async install(req: InstallRequest): Promise<{ memberId: string; domain: string }> {
    const { REFRESH_ID, SERVER_ENDPOINT, APPLICATION_TOKEN, member_id } = req;
    if (!REFRESH_ID || !SERVER_ENDPOINT || !APPLICATION_TOKEN || !member_id) {
      throw new Bitrix24Error('BAD_INSTALL_REQUEST', 'Install request is missing REFRESH_ID / SERVER_ENDPOINT / APPLICATION_TOKEN / member_id');
    }
    const host = trustedOAuthHost(SERVER_ENDPOINT, this.config.trustedOAuthHosts);
    const tokens = await this.oauth.refresh(host, REFRESH_ID);
    if (tokens.memberId !== member_id) throw new Bitrix24Error('MEMBER_MISMATCH', 'member_id does not match the authorization server');

    const client = this.portals.clientWithToken(tokens.clientEndpoint, tokens.memberId, tokens.accessToken);
    const admin = await client.call<boolean>('user.admin');
    if (admin.result !== true) throw new Bitrix24Error('NOT_ADMIN', 'Only a Bitrix24 administrator can install the application', 403);

    const portal = await this.portals.saveInstallation(tokens, APPLICATION_TOKEN);
    const appClient = this.portals.clientFor(portal);
    const scope = await appClient.call<string[]>('scope');
    if (Array.isArray(scope.result)) await this.portals.updateScope(portal.id, scope.result);
    await this.bindEvents(appClient);
    this.logger.log(`installed on ${portal.domain} (${portal.memberId})`);
    return { memberId: portal.memberId, domain: portal.domain };
  }

  private async bindEvents(client: ReturnType<PortalService['clientFor']>) {
    if (!this.config.appBaseUrl) {
      this.logger.warn('APP_BASE_URL is not set — event handlers are not bound');
      return;
    }
    const handler = `${this.config.appBaseUrl.replace(/\/$/, '')}/api/b24/events`;
    for (const event of BOUND_EVENTS) {
      try {
        await client.call('event.bind', { event, handler });
      } catch (err) {
        // Повторная установка: обработчик уже привязан — это нормально.
        if (err instanceof Bitrix24Error && /already|exist/i.test(err.message)) continue;
        throw err;
      }
    }
  }
}
