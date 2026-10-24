import type { WireMedia } from './media.js';

/** Сообщение мессенджера в виде для api (без библиотечных объектов). */
export interface WireMessage {
  /** ID сообщения в мессенджере (WhatsApp: `true_79991234567@c.us_3EB0…`). */
  id: string;
  /** Чат: собеседник (`79991234567@c.us`) или группа (`…@g.us`). */
  chatId: string;
  fromMe: boolean;
  /** Отправитель в группе. */
  author: string | null;
  /** Имя собеседника в мессенджере (если он его указал). */
  name: string | null;
  /** Номер собеседника, если чат адресован скрытым идентификатором (`…@lid`) и номер известен. */
  phone?: string | null;
  body: string;
  /** `chat`, `image`, `document`, `ptt` (голосовое), `video`, `sticker`, `location`… */
  type: string;
  hasMedia: boolean;
  /** Вложение (скачано в хранилище сервиса); null — нет или ещё не скачано. */
  media?: WireMedia | null;
  /** Описание вложения из WhatsApp — до скачивания. */
  mediaInfo?: { mime: string | null; name: string | null; size: number | null } | null;
  /** Ответ на сообщение (его ID). */
  quotedId: string | null;
  /** Unix, секунды. */
  timestamp: number;
  /** 0 — отправляется, 1 — на сервере, 2 — доставлено, 3 — прочитано. */
  ack: number | null;
}

/**
 * Событие для api: новое (`message`), правка (`edit`), удаление у всех (`revoke`), статус (`ack`).
 * Порядок не гарантирован, повтор возможен — api применяет идемпотентно (по `id`).
 */
export type WireEvent =
  | { type: 'message'; instanceId: string; message: WireMessage }
  | { type: 'edit'; instanceId: string; id: string; chatId: string; body: string; prevBody: string; at: number }
  | { type: 'revoke'; instanceId: string; id: string; chatId: string; at: number }
  | { type: 'ack'; instanceId: string; id: string; ack: number };

type WaId = string | { _serialized?: string; id?: string; remote?: WaId; fromMe?: boolean; user?: string; server?: string } | null | undefined;
type WaMessage = {
  id: WaId;
  from: WaId;
  to: WaId;
  fromMe: boolean;
  author?: WaId;
  body: string;
  type: string;
  hasMedia: boolean;
  hasQuotedMsg?: boolean;
  timestamp: number;
  ack?: number;
  _data?: { notifyName?: string; quotedStanzaID?: string; mimetype?: string; filename?: string; size?: number };
};

/**
 * Идентификатор WhatsApp в строку. Новые версии WhatsApp Web отдают то строку, то объект: с
 * `_serialized`, только с `user`/`server` или ключ сообщения `{fromMe, remote, id}` — собираем сами.
 */
export function widOf(v: WaId): string {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (v._serialized) return v._serialized;
  if (v.user && v.server) return `${v.user}@${v.server}`;
  if (v.id && v.remote !== undefined) return `${v.fromMe ? 'true' : 'false'}_${widOf(v.remote)}_${v.id}`;
  return '';
}

/** Новые модели WA отдают MessageKey без _serialized, но методы whatsapp-web.js ждут это поле. */
export function ensureSerializedId<T extends { id?: WaId }>(message: T): T {
  const key = message.id;
  if (key && typeof key === 'object' && !key._serialized) {
    const serialized = widOf(key); if (serialized) key._serialized = serialized;
  }
  return message;
}

export function toWire(m: WaMessage): WireMessage {
  return {
    id: widOf(m.id),
    chatId: widOf(m.fromMe ? m.to : m.from),
    fromMe: !!m.fromMe,
    author: widOf(m.author) || null,
    name: m.fromMe ? null : (m._data?.notifyName ?? null),
    body: m.body ?? '',
    type: m.type,
    hasMedia: !!m.hasMedia,
    mediaInfo: m.hasMedia ? { mime: m._data?.mimetype ?? null, name: m._data?.filename ?? null, size: typeof m._data?.size === 'number' ? m._data.size : null } : null,
    quotedId: m.hasQuotedMsg ? (m._data?.quotedStanzaID ?? null) : null,
    timestamp: m.timestamp || Math.floor(Date.now() / 1000),
    ack: typeof m.ack === 'number' ? m.ack : null,
  };
}

/** Служебные чаты (статусы, рассылки) — не переписка с клиентом. */
export const isClientChat = (chatId: string) => !chatId.endsWith('@broadcast') && !chatId.endsWith('@newsletter');

/**
 * Доставка событий в api с повторами (api перезапускается при выкладке). Очередь — в памяти, до
 * `MAX` событий; потерянное при перезапуске сервиса добирается загрузкой истории.
 */
export class Outbox {
  private readonly queue: WireEvent[] = [];
  private running = false;
  static readonly MAX = 5000;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly log: (m: string) => void = (m) => console.log(m),
    private readonly send: typeof fetch = fetch,
  ) {}

  push(e: WireEvent): void {
    if (!this.url) return;
    if (this.queue.length >= Outbox.MAX) this.queue.shift();
    this.queue.push(e);
    void this.drain();
  }

  get size(): number {
    return this.queue.length;
  }

  async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    let wait = 1000;
    try {
      while (this.queue.length) {
        const batch = this.queue.slice(0, 50);
        const ok = await this.send(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(this.token ? { 'x-messenger-token': this.token } : {}) },
          body: JSON.stringify({ events: batch }),
          signal: AbortSignal.timeout(15_000),
        }).then((r) => r.ok, () => false);
        if (ok) {
          this.queue.splice(0, batch.length);
          wait = 1000;
        } else {
          this.log(`outbox: api не принял ${batch.length} событий, повтор через ${wait / 1000} с`);
          await new Promise((r) => setTimeout(r, wait));
          wait = Math.min(wait * 2, 60_000);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
