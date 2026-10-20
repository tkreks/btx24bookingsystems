/** Контракт `GET /api/session` — кто открыл приложение и откуда. */
export interface SessionInfo {
  portal: { domain: string; timezone: string };
  user: { id: number; name: string; isAdmin: boolean };
  /** Может управлять группами и настройками приложения (админ портала или из списка AppAdmin). */
  canManageApp: boolean;
  /** Интеграция работает только на чтение (B24_READ_ONLY). */
  readOnly: boolean;
}

/** Ошибки API в едином формате: `{ code, message }`. */
export interface ApiError {
  code: string;
  message: string;
}
