import { normalizeClientPhone } from './phones.js';
/** Мессенджеры для связи с клиентом первым (ADR 0014). */
export const MESSENGER_KINDS = [
  { kind: 'whatsapp', label: 'WhatsApp', available: true },
  { kind: 'telegram', label: 'Telegram', available: true },
  { kind: 'max', label: 'MAX', available: true },
] as const;
export type MessengerKind = (typeof MESSENGER_KINDS)[number]['kind'];

/** Вход только на экране браузера (QR или номер и код там же) — без кода по номеру, как у WhatsApp. */
export const isScreenLoginKind = (kind: string) => kind === 'telegram' || kind === 'max';
/** Название мессенджера для подписей («MAX +7999…»). */
export const messengerLabel = (kind: string) => MESSENGER_KINDS.find((k) => k.kind === kind)?.label ?? kind;

/** Как входить: код по номеру («Связанные устройства → Связать по номеру телефона») или QR-код. */
export type MessengerAuthMode = 'code' | 'qr';

/**
 * Состояние: `starting` — браузер запускается; `pairing` — введите код в телефоне; `qr` — отсканируйте
 * QR; `authenticated`/`ready` — подключён; `disconnected` — связь потеряна; `logged_out` — вход отозван
 * в телефоне; `failed` — ошибка; `stopped` — остановлен; `unavailable` — сервис мессенджеров не отвечает.
 */
export type MessengerState = 'stopped' | 'starting' | 'pairing' | 'qr' | 'authenticated' | 'ready' | 'disconnected' | 'logged_out' | 'failed' | 'unavailable';

export const MESSENGER_STATE_LABELS: Record<MessengerState, string> = {
  stopped: 'Остановлен',
  starting: 'Запускается…',
  pairing: 'Ждёт ввода кода в телефоне',
  qr: 'Ждёт сканирования QR-кода',
  authenticated: 'Вход выполнен, загружается…',
  ready: 'Подключён',
  disconnected: 'Связь потеряна',
  logged_out: 'Вход отозван в телефоне',
  failed: 'Ошибка',
  unavailable: 'Сервис мессенджеров недоступен',
};

export interface MessengerDto {
  id: string;
  kind: MessengerKind;
  phone: string;
  auth: MessengerAuthMode;
  title: string | null;
  state: MessengerState;
  /** Код для входа по номеру (8 символов). */
  code: string | null;
  /** Строка QR-кода. */
  qr: string | null;
  account: string | null;
  error: string | null;
  connectedAt: string | null;
  createdAt: string;
  /** Привязанная открытая линия Битрикс24. */
  line: MessengerLineDto | null;
  /** Группы приложения, которым доступен номер. */
  groupIds: string[];
}

export interface CreateMessengerDto {
  kind: MessengerKind;
  phone: string;
  auth?: MessengerAuthMode;
  title?: string;
}

/** Билет на экран по VNC: адрес WebSocket (одноразовый, ~1 минута). */
export interface MessengerVncTicketDto {
  url: string;
}

/** Состояния «с ошибкой» — номер показывается в блоке дашборда «Мессенджеры» с описанием ошибки. */
export const MESSENGER_ERROR_STATES: MessengerState[] = ['failed', 'disconnected', 'logged_out', 'unavailable'];

/**
 * `GET /api/messengers/status` — блок дашборда «Мессенджеры»: все номера групп сотрудника с состоянием;
 * `canScreen` — можно открыть экран (VNC): право писать с номера.
 */
export interface MessengerStatusDto {
  id: string;
  kind: MessengerKind;
  phone: string;
  title: string | null;
  state: MessengerState;
  /** Описание ошибки для людей (только у состояний из `MESSENGER_ERROR_STATES`). */
  error: string | null;
  canScreen: boolean;
}

/** Файл для отправки с экрана мессенджера: хранится час, потом удаляется. */
export interface MessengerScreenFileDto {
  id: string;
  name: string;
  mime: string;
  size: number;
  createdAt: string;
  expiresAt: string;
  /** Когда подставлен в окно выбора файла мессенджера. */
  attachedAt: string | null;
}

/** `GET|POST /api/messengers/:id/screen-files`; `offer` — ждём нажатия 📎 на экране (до `until`). */
export interface MessengerScreenFilesDto {
  files: MessengerScreenFileDto[];
  offer: { fileId: string; until: string } | null;
}

/** Номер телефона → только цифры с кодом страны (8XXXXXXXXXX и 9XXXXXXXXX → 7…); null — не похоже на номер. */
export function normalizeMessengerPhone(input: unknown): string | null {
  return normalizeClientPhone(input);
}

/**
 * Логин Telegram (`@ivan_petrov`, `t.me/ivan_petrov`, `ivan_petrov`) → `ivan_petrov`; не логин — null.
 * Правила Telegram: 5–32 символа, латиница, цифры и `_`, начинается с буквы.
 */
export function normalizeMessengerLogin(input: unknown): string | null {
  const s = String(input ?? '').trim().replace(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\//i, '').replace(/^@/, '').replace(/\/+$/, '');
  return /^[a-z][a-z0-9_]{4,31}$/i.test(s) ? s : null;
}

/** Привязка к открытой линии: своя линия приложения (`own`) — к чужой линии номер не привязывается. */
export type MessengerLineMode = 'own';

export interface MessengerLineDto {
  mode: MessengerLineMode;
  lineId: number;
  name: string | null;
}

/** Открытая линия портала (для выбора в «Сопоставить»). */
export interface OpenLineOptionDto {
  id: number;
  name: string;
  active: boolean;
}

export type MessengerLinkDto = { mode: 'own'; name: string } | { mode: null };

export interface MessengerChatDto {
  chatId: string;
  phone: string | null;
  name: string | null;
  lastMessageAt: string | null;
  lastText: string | null;
  unread: number;
}

export interface MessengerMessageDto {
  id: string;
  externalId: string;
  chatId: string;
  fromMe: boolean;
  body: string;
  type: string;
  hasMedia: boolean;
  /** Вложение (тип, имя, размер); файл — `GET …/messages/:id/media`. null — нет или ещё не скачано. */
  media: { mime: string; name: string | null; size: number | null } | null;
  sentAt: string;
  /** 0 отправляется · 1 на сервере · 2 доставлено · 3 прочитано. */
  ack: number | null;
  editedAt: string | null;
  /** Прежние тексты (история правок). */
  edits: { at: string; body: string }[];
  deletedAt: string | null;
  source: 'messenger' | 'app' | 'bitrix';
  relayError: string | null;
  dealId?: number | null;
  awaitingDeal?: boolean;
  /** Группа: имя написавшего участника. */
  authorName?: string | null;
  /** Реакции из мессенджера (только просмотр). */
  reactions?: import('./openlines.js').ChatReactionDto[];
}

/** Отправка через открытую линию: сообщение уйдёт клиенту, когда его доставит линия (очередь). */
export interface MessengerSendResultDto {
  /** Уже в переписке (напрямую или первый контакт). */
  message: MessengerMessageDto | null;
  /** Передано в открытую линию — появится в переписке после доставки. */
  queued: boolean;
  /** Чат открытой линии с клиентом (своя линия): новый диалог открывается в «Чатах», а не в окне мессенджера. */
  openlineChatId?: number | null;
}

export interface MessengerSendDto {
  dealId?: number | null;
  /** Номер телефона или ID чата. */
  to: string;
  text: string;
}

/** Файл для отправки в мессенджер — не больше (видео, документы). */
export const MESSENGER_MAX_FILE_BYTES = 64 * 1024 * 1024;

export interface MessengerClientContextDto {
  /** Собственная линия: открыть переписку по сделкам с теми же правами. */
  messenger?: MessengerDto;
  chatId?: string;
  phone: string | null;
  contacts: { id: number; name: string }[];
  deals: { id: number; title: string; contactId: number | null; active: boolean; opportunity: number | null; currency: string | null }[];
  activeDealId: number | null;
  needsChoice: boolean;
  pending: number;
  note: string | null;
}
export interface MessengerContactSearchDto {
  existingChats?: { chatId: number; title: string; connector: string }[];
  /** Номер (цифры) — при поиске по номеру; '' — при поиске по логину. */
  phone: string;
  /** Логин Telegram — при поиске по логину (проверяются только подключения Telegram). */
  login?: string | null;
  results: { messenger: MessengerDto; status: 'found' | 'not_found' | 'unavailable'; chatId: string | null; canSend: boolean; note: string | null; openlineChatId: number | null }[];
}
