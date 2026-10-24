/** Мессенджеры, которые сервис умеет поднимать. Telegram и MAX — следующими (тот же браузерный подход). */
export const MESSENGER_KINDS = ['whatsapp'] as const;
export type MessengerKind = (typeof MESSENGER_KINDS)[number];

/** Как входить: код по номеру телефона («Связать по номеру») или QR-код (видно на экране браузера). */
export type AuthMode = 'code' | 'qr';

/** Что поднять: задаёт api (id — ID записи `Messenger` в его базе). */
export interface InstanceSpec {
  id: string;
  kind: MessengerKind;
  /** Только цифры, с кодом страны: 79991234567. */
  phone: string;
  auth: AuthMode;
  /** Номер виртуального экрана Xvfb (`:N`) и порт VNC `5900 + N` — постоянные для экземпляра. */
  display: number;
}

/**
 * Состояние экземпляра: `starting` — браузер запускается; `pairing` — ждём ввода кода в телефоне;
 * `qr` — ждём скан QR; `authenticated` → `ready` — вошли; `disconnected` — связь потеряна (перезапуск
 * восстановит сессию); `logged_out` — вход отозван в телефоне (нужен новый вход); `failed` — ошибка.
 */
export type InstanceState = 'stopped' | 'starting' | 'pairing' | 'qr' | 'authenticated' | 'ready' | 'disconnected' | 'logged_out' | 'failed';

export interface InstanceStatus {
  id: string;
  kind: MessengerKind;
  phone: string;
  auth: AuthMode;
  state: InstanceState;
  /** Код для «Связать по номеру телефона» (8 символов). */
  code: string | null;
  /** Строка QR-кода (для отрисовки на клиенте). */
  qr: string | null;
  /** Номер вошедшего аккаунта (wid), например 79991234567@c.us. */
  account: string | null;
  error: string | null;
  updatedAt: string;
}

/** Номер телефона → только цифры (8XXXXXXXXXX → 7XXXXXXXXXX); null — не похоже на номер. */
export function normalizePhone(input: unknown): string | null {
  let d = String(input ?? '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('8')) d = `7${d.slice(1)}`;
  if (d.length === 10 && d.startsWith('9')) d = `7${d}`;
  return d.length >= 10 && d.length <= 15 ? d : null;
}

export const isKind = (v: unknown): v is MessengerKind => (MESSENGER_KINDS as readonly unknown[]).includes(v);
export const ID_RE = /^[a-z0-9]{8,40}$/;
