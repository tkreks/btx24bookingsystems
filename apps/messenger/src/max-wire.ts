import { decode, encode, ExtensionCodec } from '@msgpack/msgpack';
import type { WireEvent, WireMessage } from './messages.js';

/**
 * Протокол MAX Web (`wss://api.oneme.ru/websocket`), как его говорит сама страница web.max.ru:
 * двоичный кадр = заголовок 10 байт (версия 10, `cmd`, `seq` int16, `opcode` int16, байт сжатия,
 * длина 3 байта) + msgpack; сжатие — блок LZ4 (байт сжатия > 0: размер после распаковки ≤ длина × байт).
 * `cmd`: 0 — запрос (или событие сервера), 1 — ответ, 3 — ошибка. Длинные ID — расширение msgpack 1
 * (внутри int64), как у страницы: `bigint` при кодировании, число или `bigint` при разборе.
 */
export const PROTO_VERSION = 10;
const HEADER = 10;

export const OP = {
  ping: 1,
  logout: 20,
  login: 19,
  contacts: 32,
  contactByPhone: 46,
  history: 49,
  send: 64,
  remove: 66,
  edit: 67,
  messages: 71,
  photoUpload: 80,
  videoPlay: 83,
  fileUpload: 87,
  fileDownload: 88,
  notifMessage: 128,
  notifMark: 130,
  notifAttach: 136,
  notifDelete: 142,
} as const;

const ext = new ExtensionCodec();
ext.register({
  type: 1,
  encode: (v: unknown) => (typeof v === 'bigint' ? encode(v, { useBigInt64: true }) : null),
  decode: (data: Uint8Array) => {
    const v = decode(data, { useBigInt64: true }) as bigint | number;
    return typeof v === 'bigint' && v >= -(2n ** 53n - 1n) && v <= 2n ** 53n - 1n ? Number(v) : v;
  },
});

export interface Frame {
  cmd: number;
  seq: number;
  opcode: number;
  payload: unknown;
}

export function encodeFrame(f: Frame): Buffer {
  const body = f.payload === undefined ? new Uint8Array() : encode(f.payload, { extensionCodec: ext, ignoreUndefined: true });
  const out = Buffer.alloc(HEADER + body.length);
  out[0] = PROTO_VERSION;
  out[1] = f.cmd;
  out.writeInt16BE(f.seq, 2);
  out.writeInt16BE(f.opcode, 4);
  // Без сжатия (байт 6 = 0): страница сама сжимает только длинные кадры, сервер принимает оба вида.
  out.writeUIntBE(body.length, 7, 3);
  out.set(body, HEADER);
  return out;
}

export function decodeFrame(buf: Uint8Array): Frame {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < HEADER) throw new Error('MAX: короткий кадр');
  const f: Frame = { cmd: b[1], seq: b.readInt16BE(2), opcode: b.readInt16BE(4), payload: undefined };
  const len = b.readUIntBE(7, 3);
  if (len <= 0) return f;
  let data: Uint8Array = b.subarray(HEADER, HEADER + len);
  if (data.length !== len) throw new Error('MAX: длина кадра не совпадает');
  if (b[6] > 0) data = lz4Block(data, len * b[6]);
  f.payload = decode(data, { extensionCodec: ext });
  return f;
}

/** Распаковка одного блока LZ4 (без заголовка кадра LZ4) — так сжимает страница и сервер. */
export function lz4Block(src: Uint8Array, maxOut: number): Uint8Array {
  const out = new Uint8Array(maxOut);
  let i = 0;
  let o = 0;
  const bad = () => new Error(`MAX: повреждённый блок LZ4 (${i})`);
  while (i < src.length) {
    const token = src[i++];
    let lit = token >>> 4;
    if (lit === 15) {
      let b;
      do {
        if (i >= src.length) throw bad();
        lit += b = src[i++];
      } while (b === 255);
    }
    if (i + lit > src.length || o + lit > maxOut) throw bad();
    out.set(src.subarray(i, i + lit), o);
    i += lit;
    o += lit;
    if (i >= src.length) break;
    if (i + 2 > src.length) throw bad();
    const offset = src[i++] | (src[i++] << 8);
    if (offset === 0 || offset > o) throw bad();
    let len = (token & 15) + 4;
    if ((token & 15) === 15) {
      let b;
      do {
        if (i >= src.length) throw bad();
        len += b = src[i++];
      } while (b === 255);
    }
    if (o + len > maxOut) throw bad();
    // Пересекающееся копирование (offset < len) — побайтно, как требует LZ4.
    for (let k = 0; k < len; k++, o++) out[o] = out[o - offset];
  }
  return out.subarray(0, o);
}

/** Длинный ID MAX → строка (приходит числом или `bigint`). */
export const idStr = (v: unknown): string => (typeof v === 'bigint' || typeof v === 'number' ? String(v) : typeof v === 'string' ? v : '');

/** Объекты MAX — только нужные поля. */
export interface MaxContact {
  id: number | bigint;
  phone?: number | bigint | string;
  names?: { name?: string; firstName?: string; lastName?: string; type?: string }[];
  /** Битовые флаги: 1 — официальный аккаунт, 2 — бот. */
  flags?: number;
}
export interface MaxAttach {
  _type: string;
  photoToken?: string;
  photoId?: number;
  baseUrl?: string;
  url?: string;
  videoId?: number;
  token?: string;
  audioId?: number;
  fileId?: number;
  name?: string;
  size?: number | bigint;
  MP4_1080?: string;
  deleted?: boolean;
}
export interface MaxMessage {
  id: number | bigint;
  time: number;
  type?: string;
  sender?: number | bigint;
  text?: string;
  status?: 'EDITED' | 'REMOVED' | string;
  attaches?: MaxAttach[];
  link?: { type: string; message?: { id: number | bigint }; chatId?: number | bigint };
}
export interface MaxChat {
  id: number | bigint;
  type: 'DIALOG' | 'CHAT' | 'CHANNEL' | string;
  participants?: Record<string, number>;
  lastEventTime?: number;
  lastMessage?: MaxMessage;
}

/**
 * ID сообщения: `max_<chatId>_<messageId>`. Правка, удаление и вложение в MAX требуют и чат, и
 * сообщение — оба в ID, памяти сервиса не нужно.
 */
export const wireIdOf = (chatId: unknown, msgId: unknown) => `max_${idStr(chatId)}_${idStr(msgId)}`;
export function parseWireId(wireId: string): { chatId: bigint; messageId: bigint } | null {
  const m = /^max_(-?\d{1,20})_(\d{1,20})$/.exec(wireId);
  return m ? { chatId: BigInt(m[1]), messageId: BigInt(m[2]) } : null;
}

/** Личный чат с собеседником: ID чата = ID собеседника XOR свой ID (так считает и страница). */
export const dialogIdOf = (me: string, contactId: string) => BigInt(me) ^ BigInt(contactId);
/** Собеседник — `<contactId>@lid` (номер — в `phone`, если MAX его показывает), как у Telegram. */
export const contactOfChat = (chatId: string): string | null => /^(\d{1,20})@lid$/.exec(chatId)?.[1] ?? null;

export const nameOf = (c: MaxContact | undefined): string | null => {
  const n = c?.names?.find((x) => x.type !== 'CUSTOM') ?? c?.names?.[0];
  return n?.name?.trim() || [n?.firstName, n?.lastName].filter(Boolean).join(' ').trim() || null;
};
export const phoneOf = (c: MaxContact | undefined): string | null => (c?.phone != null ? String(c.phone).replace(/\D/g, '') || null : null);
/** Живой собеседник: не бот и не официальный аккаунт (уведомления MAX). */
export const isClientContact = (c: MaxContact | undefined) => !!c && !((c.flags ?? 0) & 3);

/** Тип вложения в терминах приложения (как у WhatsApp: image, video, ptt, document, sticker, location). */
export function mediaTypeOf(attaches: MaxAttach[] | undefined): { type: string; info: WireMessage['mediaInfo']; attach: MaxAttach | null } | null {
  const a = attaches?.find((x) => x._type !== 'CONTROL' && x._type !== 'INLINE_KEYBOARD' && x._type !== 'REPLY_KEYBOARD' && x._type !== 'SHARE' && !x.deleted);
  if (!a) return null;
  const size = a.size != null ? Number(a.size) : null;
  switch (a._type) {
    case 'PHOTO':
      return { type: 'image', info: { mime: 'image/jpeg', name: null, size: null }, attach: a };
    case 'VIDEO':
      return { type: 'video', info: { mime: 'video/mp4', name: null, size }, attach: a };
    case 'AUDIO':
      return { type: 'ptt', info: { mime: null, name: null, size: null }, attach: a };
    case 'FILE':
      return { type: 'document', info: { mime: null, name: a.name ?? null, size }, attach: a };
    case 'STICKER':
      return { type: 'sticker', info: null, attach: null };
    case 'LOCATION':
      return { type: 'location', info: null, attach: null };
    default:
      // Контакт, опрос, звонок и прочее — без файла.
      return { type: 'unknown', info: null, attach: null };
  }
}

/** Сообщение MAX → вид для api; null — не переписка с клиентом (группа, канал, бот, «Избранное»). */
export function toWire(chatId: unknown, m: MaxMessage, me: string, contacts: Map<string, MaxContact>): WireMessage | null {
  const chat = idStr(chatId);
  if (!/^\d+$/.test(chat) || chat === '0' || !me) return null;
  const peer = String(BigInt(chat) ^ BigInt(me));
  const contact = contacts.get(peer);
  if (contact && !isClientContact(contact)) return null;
  const fromMe = idStr(m.sender) === me;
  const media = mediaTypeOf(m.attaches);
  const quoted = m.link?.type === 'REPLY' && m.link.message ? wireIdOf(m.link.chatId ?? chat, m.link.message.id) : null;
  return {
    id: wireIdOf(chat, m.id),
    chatId: `${peer}@lid`,
    fromMe,
    author: null,
    name: fromMe ? null : nameOf(contact),
    phone: phoneOf(contact),
    body: m.text ?? '',
    type: media?.type ?? 'chat',
    hasMedia: !!media?.info,
    mediaInfo: media?.info ?? null,
    quotedId: quoted,
    // В MAX время — миллисекунды.
    timestamp: Math.floor((m.time || Date.now()) / 1000),
    ack: fromMe ? 1 : null,
  };
}

/** Память сервиса: текст (для «было → стало» при правке) и свои непрочитанные (для «прочитано»). */
export interface MaxMemory {
  bodyOf: Map<string, string>;
  unread: Map<string, { id: string; time: number }[]>;
}
export const newMemory = (): MaxMemory => ({ bodyOf: new Map(), unread: new Map() });

export function remember(mem: MaxMemory, w: WireMessage, timeMs: number) {
  mem.bodyOf.set(w.id, w.body);
  if (mem.bodyOf.size > 20_000) mem.bodyOf.delete(mem.bodyOf.keys().next().value!);
  if (!w.fromMe) return;
  const list = mem.unread.get(w.chatId) ?? [];
  list.push({ id: w.id, time: timeMs });
  mem.unread.set(w.chatId, list.slice(-200));
}

/**
 * Событие сервера → события для api. Новое сообщение (128) — `message` (его отдаём отдельно: может
 * понадобиться скачать вложение); то же сообщение со статусом EDITED/REMOVED — правка/удаление;
 * 142 — удаление; 130 от собеседника — «прочитано» до отметки времени.
 */
export function eventsOf(
  instanceId: string,
  opcode: number,
  payload: unknown,
  me: string,
  contacts: Map<string, MaxContact>,
  mem: MaxMemory,
): { events: WireEvent[]; message: { wire: WireMessage; raw: MaxMessage } | null } {
  const events: WireEvent[] = [];
  const p = (payload ?? {}) as Record<string, unknown>;
  const now = Math.floor(Date.now() / 1000);
  if (opcode === OP.notifMessage && p.message) {
    if ((p.chat as MaxChat | undefined)?.type && (p.chat as MaxChat).type !== 'DIALOG') return { events, message: null };
    const raw = p.message as MaxMessage;
    const wire = toWire(p.chatId, raw, me, contacts);
    if (!wire) return { events, message: null };
    if (raw.status === 'REMOVED') {
      events.push({ type: 'revoke', instanceId, id: wire.id, chatId: wire.chatId, at: now });
      return { events, message: null };
    }
    if (raw.status === 'EDITED' && mem.bodyOf.has(wire.id)) {
      const prevBody = mem.bodyOf.get(wire.id)!;
      if (prevBody !== wire.body) events.push({ type: 'edit', instanceId, id: wire.id, chatId: wire.chatId, body: wire.body, prevBody, at: now });
      mem.bodyOf.set(wire.id, wire.body);
      return { events, message: null };
    }
    remember(mem, wire, raw.time);
    return { events, message: { wire, raw } };
  }
  if (opcode === OP.notifDelete) {
    const chat = (p.chat ?? {}) as MaxChat;
    const chatId = idStr(chat.id);
    if (!/^\d+$/.test(chatId) || !me || chat.type !== 'DIALOG') return { events, message: null };
    const peer = `${String(BigInt(chatId) ^ BigInt(me))}@lid`;
    for (const id of (p.messageIds as unknown[]) ?? []) events.push({ type: 'revoke', instanceId, id: wireIdOf(chatId, id), chatId: peer, at: now });
    return { events, message: null };
  }
  if (opcode === OP.notifMark) {
    const chatId = idStr(p.chatId);
    const user = idStr(p.userId);
    if (!/^\d+$/.test(chatId) || !me || user === me) return { events, message: null };
    const peer = `${String(BigInt(chatId) ^ BigInt(me))}@lid`;
    const mark = Number(p.mark ?? 0);
    const list = mem.unread.get(peer) ?? [];
    const rest = list.filter((x) => x.time > mark);
    for (const x of list) if (x.time <= mark) events.push({ type: 'ack', instanceId, id: x.id, ack: 3 });
    mem.unread.set(peer, rest);
  }
  return { events, message: null };
}
