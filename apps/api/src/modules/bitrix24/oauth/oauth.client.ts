import { Bitrix24Error } from '../rest/errors.js';

/** Доверенный ответ сервера авторизации (oauth.bitrix.info или сам «коробочный» портал). */
export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  memberId: string;
  clientEndpoint: string;
  serverEndpoint: string;
  scope: string;
  userId: number | null;
  status: string | null;
}

/**
 * Хост сервера авторизации из SERVER_ENDPOINT. Значение приходит от клиента (POST установки),
 * поэтому принимаем только хосты из B24_TRUSTED_OAUTH_HOSTS — иначе злоумышленник подсунул бы
 * свой «сервер авторизации» и зарегистрировал поддельный портал.
 */
export function trustedOAuthHost(serverEndpoint: string, trustedHosts: string[]): string {
  let url: URL;
  try {
    url = new URL(serverEndpoint);
  } catch {
    throw new Bitrix24Error('UNTRUSTED_OAUTH_SERVER', 'SERVER_ENDPOINT is not a valid URL');
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !trustedHosts.includes(host)) {
    throw new Bitrix24Error('UNTRUSTED_OAUTH_SERVER', `Authorization server ${host} is not in B24_TRUSTED_OAUTH_HOSTS`);
  }
  return host;
}

export class OAuthClient {
  constructor(
    private readonly clientId: string | undefined,
    private readonly clientSecret: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get configured(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  /** Страница входа портала: сотрудник подтверждает вход, портал возвращает его на `redirectUri` с `code`. */
  authorizeUrl(portalDomain: string, state: string, redirectUri: string): string {
    if (!this.clientId) throw new Bitrix24Error('APP_NOT_CONFIGURED', 'B24_CLIENT_ID is not set');
    const qs = new URLSearchParams({ client_id: this.clientId, state, redirect_uri: redirectUri });
    return `https://${portalDomain}/oauth/authorize/?${qs}`;
  }

  /** Обмен refresh_token на новую пару. client_secret уходит только на сервер авторизации. */
  refresh(oauthHost: string, refreshToken: string): Promise<TokenSet> {
    return this.token(oauthHost, { grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  /**
   * Вход через Битрикс24 вне портала (решение владельца 2026-10-22): одноразовый `code`, которым
   * портал вернул сотрудника в приложение, → токены этого сотрудника.
   */
  exchangeCode(oauthHost: string, code: string): Promise<TokenSet> {
    return this.token(oauthHost, { grant_type: 'authorization_code', code });
  }

  private async token(oauthHost: string, grant: Record<string, string>): Promise<TokenSet> {
    if (!this.clientId || !this.clientSecret) {
      throw new Bitrix24Error('APP_NOT_CONFIGURED', 'B24_CLIENT_ID / B24_CLIENT_SECRET are not set');
    }
    const qs = new URLSearchParams({ ...grant, client_id: this.clientId, client_secret: this.clientSecret });
    let res: Response;
    try {
      res = await this.fetchImpl(`https://${oauthHost}/oauth/token/?${qs}`, { signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      throw new Bitrix24Error('NETWORK_ERROR', `OAuth server request failed: ${(err as Error).message}`);
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.error || !body.access_token || !body.refresh_token || !body.member_id || !body.client_endpoint) {
      const code = String(body.error ?? 'ERROR_UNEXPECTED_ANSWER');
      throw new Bitrix24Error(code, String(body.error_description ?? code), res.status);
    }
    const expiresAt = typeof body.expires === 'number' ? new Date(body.expires * 1000) : new Date(Date.now() + Number(body.expires_in ?? 3600) * 1000);
    return {
      accessToken: String(body.access_token),
      refreshToken: String(body.refresh_token),
      expiresAt,
      memberId: String(body.member_id),
      clientEndpoint: String(body.client_endpoint),
      serverEndpoint: String(body.server_endpoint ?? `https://${oauthHost}/rest/`),
      scope: String(body.scope ?? ''),
      userId: body.user_id === undefined ? null : Number(body.user_id),
      status: body.status === undefined ? null : String(body.status),
    };
  }
}
