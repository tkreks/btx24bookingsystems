/** DI-токены модуля bitrix24 (подменяются в тестах). */
export const B24_CONFIG = Symbol('B24_CONFIG');
export const B24_FETCH = Symbol('B24_FETCH');

export interface Bitrix24Config {
  appBaseUrl: string | undefined;
  trustedOAuthHosts: string[];
  /** Только чтение данных портала (B24_READ_ONLY). */
  readOnly: boolean;
}
