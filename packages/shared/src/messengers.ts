import { normalizeClientPhone } from './phones.js';
/** Мессенджеры для связи с клиентом первым (ADR 0014). Подключаются WhatsApp и Telegram; MAX — следующим. */
export const MESSENGER_KINDS = [
  { kind: 'whatsapp', label: 'WhatsApp', available: true },
  { kind: 'telegram', label: 'Telegram', available: true },
  { kind: 'max', label: 'MAX', available: false },
] as const;
export type MessengerKind = (typeof MESSENGER_KINDS)[number]['kind'];

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

/** Номер телефона → только цифры с кодом страны (8XXXXXXXXXX и 9XXXXXXXXX → 7…); null — не похоже на номер. */
export function normalizeMessengerPhone(input: unknown): string | null {
  return normalizeClientPhone(input);
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
}

/** Отправка через открытую линию: сообщение уйдёт клиенту, когда его доставит линия (очередь). */
export interface MessengerSendResultDto {
  /** Уже в переписке (напрямую или первый контакт). */
  message: MessengerMessageDto | null;
  /** Передано в открытую линию — появится в переписке после доставки. */
  queued: boolean;
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
  phone: string;
  results: { messenger: MessengerDto; status: 'found' | 'not_found' | 'unavailable'; chatId: string | null; canSend: boolean; note: string | null; openlineChatId: number | null }[];
}
