import type { WireEvent, WireMessage } from './messages.js';

/**
 * Объекты Telegram API (MTProto, как их отдаёт Telegram Web K) — только нужные поля. Длинные числа
 * (`access_hash`, ID пользователей) у Telegram Web — строки или числа; храним строками.
 */
export interface TgUser {
  _: 'user' | 'userEmpty';
  id: string | number;
  access_hash?: string | number;
  first_name?: string;
  last_name?: string;
  username?: string;
  phone?: string;
  pFlags?: { self?: true; bot?: true; deleted?: true; support?: true };
}
export interface TgChat {
  _: string;
  id: string | number;
  title?: string;
}
type TgPeer = { _: 'peerUser'; user_id: string | number } | { _: 'peerChat'; chat_id: string | number } | { _: 'peerChannel'; channel_id: string | number };
export interface TgDocument {
  _: 'document';
  id: string | number;
  mime_type?: string;
  size?: number;
  attributes?: { _: string; file_name?: string; pFlags?: { voice?: true; round_message?: true } }[];
}
export interface TgMessage {
  _: 'message' | 'messageService' | 'messageEmpty';
  id: number;
  peer_id?: TgPeer;
  from_id?: TgPeer;
  date?: number;
  message?: string;
  pFlags?: { out?: true };
  reply_to?: { reply_to_msg_id?: number };
  media?: { _: string; photo?: { _: string; id?: string | number; sizes?: { size?: number; sizes?: number[] }[] }; document?: TgDocument };
}

/** Служебная учётка Telegram (коды входа) — её сообщения в приложение не попадают. */
export const TG_SERVICE_USER = '777000';

/**
 * ID сообщения: в личных чатах и обычных группах номера сообщений общие на весь аккаунт, поэтому
 * `tg_<номер>` уникален и по нему одному можно найти сообщение (правка, удаление, вложение).
 * Каналы и супергруппы (свои номера на каждый) не поддерживаются — это не переписка с клиентом.
 */
export const wireIdOf = (msgId: number) => `tg_${msgId}`;
export const msgIdOf = (wireId: string): number | null => {
  const n = /^tg_(\d{1,12})$/.exec(wireId)?.[1];
  return n ? Number(n) : null;
};

/** Чат: собеседник — `<userId>@lid` (номер не всегда виден; он — в `phone`), группа — `<chatId>@g.us`. */
export function chatIdOf(peer: TgPeer | undefined): string | null {
  if (peer?._ === 'peerUser') return `${peer.user_id}@lid`;
  if (peer?._ === 'peerChat') return `${peer.chat_id}@g.us`;
  return null;
}
export const userIdOfChat = (chatId: string): string | null => /^(\d{1,20})@lid$/.exec(chatId)?.[1] ?? null;

export const nameOf = (u: TgUser | undefined) => [u?.first_name, u?.last_name].filter(Boolean).join(' ').trim() || (u?.username ? `@${u.username}` : null);

/** Собеседник, с которым приложение ведёт переписку: живой человек (не бот, не «Избранное», не Telegram). */
export const isClientUser = (u: TgUser | undefined) => !!u && u._ === 'user' && !u.pFlags?.self && !u.pFlags?.bot && !u.pFlags?.deleted && !u.pFlags?.support && String(u.id) !== TG_SERVICE_USER;

/** Тип вложения в терминах приложения (как у WhatsApp: image, video, ptt, audio, sticker, location, document). */
export function mediaTypeOf(media: TgMessage['media']): { type: string; info: WireMessage['mediaInfo'] } | null {
  if (!media || media._ === 'messageMediaEmpty' || media._ === 'messageMediaWebPage') return null;
  if (media._ === 'messageMediaPhoto' && media.photo?._ === 'photo') {
    const sizes = media.photo.sizes ?? [];
    const last = sizes[sizes.length - 1];
    const size = last?.size ?? last?.sizes?.[last.sizes.length - 1] ?? null;
    return { type: 'image', info: { mime: 'image/jpeg', name: null, size } };
  }
  if (media._ === 'messageMediaGeo' || media._ === 'messageMediaGeoLive' || media._ === 'messageMediaVenue') return { type: 'location', info: null };
  if (media._ === 'messageMediaDocument' && media.document?._ === 'document') {
    const d = media.document;
    const attrs = d.attributes ?? [];
    const has = (t: string) => attrs.find((a) => a._ === t);
    const audio = has('documentAttributeAudio');
    const type = has('documentAttributeSticker')
      ? 'sticker'
      : audio
        ? audio.pFlags?.voice ? 'ptt' : 'audio'
        : has('documentAttributeVideo') ? 'video' : d.mime_type?.startsWith('image/') ? 'image' : 'document';
    return { type, info: { mime: d.mime_type ?? null, name: has('documentAttributeFilename')?.file_name ?? null, size: typeof d.size === 'number' ? d.size : null } };
  }
  // Опросы, контакты, игры и прочее — без файла, текстом-заглушкой.
  return { type: 'unknown', info: null };
}

/** Сообщение Telegram → вид для api; null — не переписка с клиентом (канал, бот, служебное). */
export function toWire(m: TgMessage, users: Map<string, TgUser>): WireMessage | null {
  if (m._ !== 'message') return null;
  const chatId = chatIdOf(m.peer_id);
  if (!chatId) return null;
  const peerUser = m.peer_id?._ === 'peerUser' ? users.get(String(m.peer_id.user_id)) : undefined;
  if (m.peer_id?._ === 'peerUser' && !isClientUser(peerUser)) return null;
  const fromMe = !!m.pFlags?.out;
  const media = mediaTypeOf(m.media);
  const authorId = m.peer_id?._ === 'peerChat' && m.from_id?._ === 'peerUser' ? String(m.from_id.user_id) : null;
  return {
    id: wireIdOf(m.id),
    chatId,
    fromMe,
    author: authorId ? `${authorId}@lid` : null,
    name: fromMe ? null : nameOf(authorId ? users.get(authorId) : peerUser),
    phone: peerUser?.phone ? peerUser.phone.replace(/\D/g, '') || null : null,
    body: m.message ?? '',
    type: media?.type ?? 'chat',
    hasMedia: !!media?.info,
    mediaInfo: media?.info ?? null,
    quotedId: m.reply_to?.reply_to_msg_id ? wireIdOf(m.reply_to.reply_to_msg_id) : null,
    timestamp: m.date || Math.floor(Date.now() / 1000),
    // Своё — «на сервере» (1); «прочитано» (3) придёт событием.
    ack: fromMe ? 1 : null,
  };
}

/** Что отследить между опросами: чат сообщения (удаление в Telegram приходит без чата), текст, свои непрочитанные. */
export interface TgMemory {
  chatOf: Map<number, string>;
  bodyOf: Map<number, string>;
  unread: Map<string, Set<number>>;
}
export const newMemory = (): TgMemory => ({ chatOf: new Map(), bodyOf: new Map(), unread: new Map() });

const LIMIT = 20_000;
function remember(mem: TgMemory, id: number, chatId: string, body: string, outUnread: boolean) {
  mem.chatOf.set(id, chatId);
  mem.bodyOf.set(id, body);
  if (mem.chatOf.size > LIMIT) {
    const first = mem.chatOf.keys().next().value as number;
    mem.chatOf.delete(first);
    mem.bodyOf.delete(first);
  }
  if (outUnread) {
    const set = mem.unread.get(chatId) ?? new Set<number>();
    set.add(id);
    if (set.size > 500) set.delete(set.values().next().value as number);
    mem.unread.set(chatId, set);
  }
}

export type TgUpdate =
  | { _: 'updateNewMessage' | 'updateEditMessage'; message: TgMessage }
  | { _: 'updateDeleteMessages'; messages: number[] }
  | { _: 'updateReadHistoryOutbox'; peer: TgPeer; max_id: number }
  | { _: string; [k: string]: unknown };

/**
 * Изменения из `updates.getDifference` → события для api. Новые (в том числе отправленные с телефона)
 * — `message`; правка — `edit` с прежним текстом (если он известен); удаление — `revoke` (в Telegram
 * удаление в личном чате — у обоих); прочтение собеседником — `ack` 3 для своих сообщений.
 */
export function eventsOf(instanceId: string, newMessages: TgMessage[], updates: TgUpdate[], users: Map<string, TgUser>, mem: TgMemory): { events: WireEvent[]; messages: Array<{ wire: WireMessage; raw: TgMessage }> } {
  const events: WireEvent[] = [];
  const messages: Array<{ wire: WireMessage; raw: TgMessage }> = [];
  const now = Math.floor(Date.now() / 1000);
  const add = (raw: TgMessage) => {
    const wire = toWire(raw, users);
    if (!wire) return;
    remember(mem, raw.id, wire.chatId, wire.body, wire.fromMe);
    messages.push({ wire, raw });
  };
  for (const m of newMessages) add(m);
  for (const u of updates) {
    if (u._ === 'updateNewMessage') add((u as { message: TgMessage }).message);
    else if (u._ === 'updateEditMessage') {
      const raw = (u as { message: TgMessage }).message;
      const wire = toWire(raw, users);
      if (!wire) continue;
      const prevBody = mem.bodyOf.get(raw.id) ?? '';
      // Правка без изменения текста (реакции, просмотры) — не событие для переписки.
      if (prevBody === wire.body && mem.bodyOf.has(raw.id)) continue;
      mem.bodyOf.set(raw.id, wire.body);
      mem.chatOf.set(raw.id, wire.chatId);
      events.push({ type: 'edit', instanceId, id: wire.id, chatId: wire.chatId, body: wire.body, prevBody, at: now });
    } else if (u._ === 'updateDeleteMessages') {
      for (const id of (u as { messages: number[] }).messages ?? []) {
        const chatId = mem.chatOf.get(id);
        // Чужие для приложения (каналы, боты) и неизвестные — пропускаем: без чата событие не применить.
        if (chatId) events.push({ type: 'revoke', instanceId, id: wireIdOf(id), chatId, at: now });
      }
    } else if (u._ === 'updateReadHistoryOutbox') {
      const r = u as { peer: TgPeer; max_id: number };
      const chatId = chatIdOf(r.peer);
      const set = chatId ? mem.unread.get(chatId) : undefined;
      if (!set) continue;
      for (const id of set) if (id <= r.max_id) {
        set.delete(id);
        events.push({ type: 'ack', instanceId, id: wireIdOf(id), ack: 3 });
      }
    }
  }
  return { events, messages };
}
