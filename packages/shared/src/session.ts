/** Контракт `GET /api/session` — кто открыл приложение и откуда. */
export interface SessionInfo {
  portal: { domain: string; timezone: string };
  user: { id: number; name: string; isAdmin: boolean };
  /** Может управлять группами и настройками приложения (админ портала или из списка AppAdmin). */
  canManageApp: boolean;
  /**
   * Может работать в приложении: администратор или есть в списке доступа (⚙ → «Приложение»).
   * false — интерфейс показывает «Доступ к приложению ограничен», API отвечает 403 `APP_ACCESS_DENIED`.
   */
  appAccess: boolean;
  /**
   * Доступ к настройкам по временному паролю — до этого времени (ISO); null — постоянный админ
   * или нет доступа. Временный админ не выдаёт пароли и не меняет список администраторов.
   */
  settingsAccessUntil: string | null;
  /** Интеграция работает только на чтение (B24_READ_ONLY). */
  readOnly: boolean;
  /** Дашборд руководителя: назначен руководителем (⚙ → «Приложение») или администратор приложения. */
  isHead: boolean;
  /** Назначен руководителем явно — приложение открывается сразу на его дашборде. */
  headAssigned: boolean;
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

/** Рабочий день сотрудника в Битрикс24 (учёт рабочего времени, `timeman.*`). */
export type WorkdayStatus = 'OPENED' | 'PAUSED' | 'CLOSED' | 'EXPIRED';

export interface WorkdayDto {
  /** false — учёт времени недоступен приложению (нет права `timeman` или выключен на портале). */
  available: boolean;
  reason: string | null;
  status: WorkdayStatus | null;
  timeStart: string | null;
  /** Отработано, HH:MM:SS. */
  duration: string | null;
  /** Перерывы, HH:MM:SS. */
  timeLeaks: string | null;
}

export type WorkdayAction = 'open' | 'pause' | 'close';
