/** Ошибка обращения к Битрикс24: REST портала или сервер авторизации. */
export class Bitrix24Error extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus?: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'Bitrix24Error';
  }
}

/** Access-токен истёк — обновить и повторить запрос (запрос портал не выполнял). */
export const TOKEN_EXPIRED_CODES = new Set(['expired_token']);
/** Превышен лимит — подождать и повторить (запрос портал не выполнял). */
export const RATE_LIMIT_CODES = new Set(['QUERY_LIMIT_EXCEEDED']);
/** Авторизация недействительна целиком — нужна переустановка или новый вход пользователя. */
export const REAUTH_CODES = new Set(['invalid_token', 'NO_AUTH_FOUND', 'INVALID_CREDENTIALS', 'invalid_grant', 'PORTAL_DELETED', 'user_access_error']);
