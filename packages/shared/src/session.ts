/** Контракт `GET /api/session` — кто открыл приложение и откуда. */
export interface SessionInfo {
  portal: { domain: string; timezone: string };
  user: { id: number; name: string; isAdmin: boolean };
  /** Может управлять группами и настройками приложения (админ портала или из списка AppAdmin). */
  canManageApp: boolean;
  /**
   * Доступ к настройкам по временному паролю — до этого времени (ISO); null — постоянный админ
   * или нет доступа. Временный админ не выдаёт пароли и не меняет список администраторов.
   */
  settingsAccessUntil: string | null;
  /** Интеграция работает только на чтение (B24_READ_ONLY). */
  readOnly: boolean;
}

/** Ошибки API в едином формате: `{ code, message }`. */
export interface ApiError {
  code: string;
  message: string;
}

/** `POST /api/admin/settings-codes` — новый временный пароль (код показывается один раз). */
export interface SettingsCodeCreatedDto {
  id: string;
  code: string;
  expiresAt: string;
}

/** Временный пароль в списке (без кода). */
export interface SettingsCodeDto {
  id: string;
  createdByUserId: number;
  createdAt: string;
  expiresAt: string;
  usedByUserId: number | null;
  usedAt: string | null;
  revokedAt: string | null;
}
