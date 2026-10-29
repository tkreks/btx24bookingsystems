import { photoUrl } from '../bitrix24/rest/photo-url.js';
import type { ChatCrmLinks, ChatMessageDto, ChatReactionDto, MessageAuthorKind } from '@btx24/shared';

/** Пользователь из ответа im.dialog.messages.get (нужные поля). */
export interface ImUser {
  id: number;
  name?: string;
  bot?: boolean;
  connector?: boolean;
  avatar?: string;
}

/** Аватарка клиента открытой линии: пользователь-коннектор (не бот) с картинкой. */
export function clientAvatarOf(users: ImUser[], domain: string): string | null {
  for (const u of users) if (u.connector && !u.bot) return photoUrl(u.avatar, domain);
  return null;
}

export interface ImMessage {
  id: number;
  author_id: number;
  date: string;
  text?: string;
  params?: { FILE_ID?: (number | string)[] } & Record<string, unknown>;
}

export interface ImFile {
  id: number;
  name?: string;
  size?: number;
  type?: string;
  urlPreview?: string | null;
  urlShow?: string | null;
  urlDownload?: string | null;
}

/**
 * Канал по `entity_id` чата открытой линии: `<connector>|<line>|<chat>|<user>`. У коннекторов
 * вроде Wazzup к коду приклеен member_id портала (`wz_whatsapp_<hash>`) — его отрезаем.
 */
export function connectorOf(entityId: string | null | undefined): string {
  const code = String(entityId ?? '').split('|')[0] ?? '';
  return code.replace(/_[0-9a-f]{32,40}$/i, '');
}

/** Привязки к CRM из `entity_data_2`: `LEAD|1|COMPANY|0|CONTACT|5|DEAL|9`. */
export function crmLinksOf(entityData2: string | null | undefined): ChatCrmLinks {
  const parts = String(entityData2 ?? '').split('|');
  const get = (type: string) => {
    const i = parts.indexOf(type);
    const id = i >= 0 ? Number(parts[i + 1]) : 0;
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  };
  return { leadId: get('LEAD'), contactId: get('CONTACT'), companyId: get('COMPANY'), dealId: get('DEAL') };
}

export function authorKind(authorId: number, users: ImUser[]): MessageAuthorKind {
  if (!authorId) return 'system';
  const u = users.find((x) => Number(x.id) === Number(authorId));
  if (u?.connector) return 'client';
  if (u?.bot) return 'bot';
  return 'employee';
}

/**
 * Сообщение, отправленное менеджером с телефона из рабочего WhatsApp: Wazzup кладёт его в чат от
 * имени клиента (коннектора) с первой строкой `=== Исходящее сообщение, автор: <кто> ===`
 * (сверено на портале 2026-10-22: 282 таких сообщения в 40 чатах, все — от коннектора).
 */
const PHONE_OUTGOING = /(^|\r?\n)[ \t]*===\s*Исходящее сообщение,\s*автор:\s*(.*?)\s*===[ \t]*(?:\r?\n|$)/i;

/** Метка — в начале текста или строки (ответ с цитатой: `>>цитата клиента`, затем метка и ответ). */
export function phoneOutgoing(text: string | null | undefined): { author: string; text: string } | null {
  const t = String(text ?? '');
  const m = PHONE_OUTGOING.exec(t);
  if (!m) return null;
  const before = t.slice(0, m.index).trimEnd();
  const after = t.slice(m.index + m[0].length);
  return { author: m[2].trim(), text: before ? `${before}\n${after}` : after };
}

/** Текст без служебной строки Wazzup. */
export const messageText = (text: string | null | undefined): string => phoneOutgoing(text)?.text ?? String(text ?? '');

/** Автор с учётом сообщений с телефона: они — наши (сотрудник), а не клиента. */
export function messageKind(m: Pick<ImMessage, 'author_id' | 'text'>, users: ImUser[]): MessageAuthorKind {
  const kind = authorKind(m.author_id, users);
  return kind === 'client' && phoneOutgoing(m.text) ? 'employee' : kind;
}

/** BB-коды мессенджера → простой текст (для превью и показа без разметки). */
export function plainText(text: string | null | undefined): string {
  return String(text ?? '')
    .replace(/\[(?:USER|CHAT|CALL|PCH|SEND|PUT|DISK)=[^\]]*\]([^[]*)\[\/(?:USER|CHAT|CALL|PCH|SEND|PUT|DISK)\]/gi, '$1')
    .replace(/\[URL=([^\]]*)\]([^[]*)\[\/URL\]/gi, '$2')
    .replace(/\[\/?[A-Z]+(?:=[^\]]*)?\]/gi, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

export function preview(text: string | null | undefined, max = 160): string {
  const s = plainText(text).replace(/\s+/g, ' ');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Последнее сообщение клиента или оператора — по нему Битрикс24 считает «Дату последнего
 * сообщения» в списке диалогов (сверено на портале): системные и сообщения ботов не считаются.
 * Нет таких — самое свежее сообщение как есть (для превью); `human: false`. `streak` — сколько
 * сообщений клиента подряд после последнего ответа сотрудника (в пределах переданных сообщений).
 */
export function lastMeaningful(
  messages: ImMessage[],
  users: ImUser[],
): { message: ImMessage; kind: MessageAuthorKind; human: boolean; streak: number } | null {
  const sorted = [...messages].sort((a, b) => b.id - a.id);
  let last: { message: ImMessage; kind: MessageAuthorKind } | null = null;
  let streak = 0;
  for (const m of sorted) {
    const kind = messageKind(m, users);
    if (kind === 'employee') {
      last ??= { message: m, kind };
      break;
    }
    if (kind === 'client') {
      last ??= { message: m, kind };
      streak++;
    }
  }
  if (last) return { ...last, human: true, streak };
  return sorted[0] ? { message: sorted[0], kind: messageKind(sorted[0], users), human: false, streak: 0 } : null;
}

export function toMessageDto(m: ImMessage, users: ImUser[], files: ImFile[]): ChatMessageDto {
  const ids = new Set((m.params?.FILE_ID ?? []).map(Number));
  const phone = authorKind(m.author_id, users) === 'client' ? phoneOutgoing(m.text) : null;
  const kind = phone ? 'employee' : authorKind(m.author_id, users);
  const user = users.find((u) => Number(u.id) === Number(m.author_id));
  return {
    id: Number(m.id),
    date: m.date,
    author: {
      id: Number(m.author_id),
      name: phone ? phone.author || 'Телефон' : kind === 'system' ? 'Система' : (user?.name ?? `#${m.author_id}`),
      kind,
      // Как отдал портал (путь бывает относительным) — в адрес превращает `withAvatars` при выдаче.
      ...(!phone && kind !== 'system' && user?.avatar ? { avatar: user.avatar } : {}),
    },
    ...(phone ? { viaPhone: true } : {}),
    ...(kind === 'employee' && !phone ? { delivery: connectorMidOf(m) ? ('delivered' as const) : ('sent' as const) } : {}),
    text: plainText(phone ? phone.text : m.text),
    files: [...ids].map((id) => {
      const f = files.find((x) => Number(x.id) === id);
      // Сотруднику не из диалога портал не отдаёт описание файла — вложение всё равно показываем
      // (`UNKNOWN_FILE`): скачивание `/files/:fileId` проверяет доступ к диалогу.
      if (!f) return { id, name: 'Вложение', size: 0, type: UNKNOWN_FILE, previewUrl: null, url: null };
      return {
        id,
        name: f.name ?? `Файл ${f.id}`,
        size: Number(f.size ?? 0),
        type: f.type ?? 'file',
        previewUrl: f.urlPreview || null,
        url: f.urlDownload || f.urlShow || null,
      };
    }),
  };
}

/** Тип вложения без описания (портал не отдал файл сотруднику, который не в диалоге). */
export const UNKNOWN_FILE = 'unknown';

/**
 * Не затирать сохранённое описание файлов «пустым»: страницу мог прочитать сотрудник не из диалога.
 * Вложение без описания берётся из прежней версии сообщения, если там оно было.
 */
export function keepKnownFiles(next: ChatMessageDto, prev: ChatMessageDto | null | undefined): ChatMessageDto {
  if (!prev?.files?.length || !next.files.some((f) => f.type === UNKNOWN_FILE)) return next;
  return { ...next, files: next.files.map((f) => (f.type === UNKNOWN_FILE ? (prev.files.find((p) => p.id === f.id && p.type !== UNKNOWN_FILE) ?? f) : f)) };
}

/** ID сообщения в мессенджере из параметров сообщения линии (`CONNECTOR_MID`) — связь с перепиской приложения. */
export function connectorMidOf(m: ImMessage): string | null {
  const mid = m.params?.CONNECTOR_MID;
  const v = Array.isArray(mid) ? mid[0] : mid;
  return typeof v === 'string' && v ? v : null;
}

/**
 * Эхо своих сообщений: Wazzup возвращает в линию отправленное из Битрикс24 сообщение ещё раз — как
 * «с телефона», с тем же `CONNECTOR_MID` (сверено на портале 2026-10-27). Такое «с телефона» —
 * не второе сообщение: ID эхо, которые надо скрыть.
 */
export function phoneEchoIds(messages: { id: number; mid?: string | null; viaPhone?: boolean }[]): Set<number> {
  const own = new Set(messages.filter((m) => m.mid && !m.viaPhone).map((m) => m.mid));
  return new Set(messages.filter((m) => m.viaPhone && m.mid && own.has(m.mid)).map((m) => m.id));
}

/** Сообщения линии без эхо своих (см. `phoneEchoIds`). */
export function withoutPhoneEchoes(messages: ImMessage[], users: ImUser[]): ImMessage[] {
  const echoes = phoneEchoIds(
    messages.map((m) => ({ id: Number(m.id), mid: connectorMidOf(m), viaPhone: authorKind(m.author_id, users) === 'client' && !!phoneOutgoing(m.text) })),
  );
  return echoes.size ? messages.filter((m) => !echoes.has(Number(m.id))) : messages;
}

/** Реакции (по одной на поставившего) → по эмодзи, в порядке появления. */
export function groupReactions(list: unknown): ChatReactionDto[] {
  const out: ChatReactionDto[] = [];
  for (const r of Array.isArray(list) ? (list as { emoji?: unknown; mine?: unknown }[]) : []) {
    if (typeof r?.emoji !== 'string' || !r.emoji) continue;
    const hit = out.find((x) => x.emoji === r.emoji);
    if (hit) {
      hit.count++;
      hit.mine ||= !!r.mine;
    } else out.push({ emoji: r.emoji, count: 1, mine: !!r.mine });
  }
  return out;
}

/**
 * Статус своего сообщения по подтверждению самого мессенджера (наши номера, `MessengerMessage.ack`:
 * 1 на сервере · 2 доставлено · 3 прочитано) — точнее признака доставки из Битрикс24.
 */
export function deliveryFromAck(m: ChatMessageDto, ack: number | null | undefined): ChatMessageDto['delivery'] {
  if (m.author.kind !== 'employee' || m.viaPhone) return m.delivery;
  return ack === 3 ? 'read' : ack === 2 ? 'delivered' : m.delivery;
}

/** Фото авторов — полными адресами портала (в базе и в ответе портала путь бывает относительным). */
export function withAvatars<T extends ChatMessageDto>(messages: T[], domain: string): T[] {
  return messages.map((m) => (m.author.avatar ? { ...m, author: { ...m.author, avatar: photoUrl(m.author.avatar, domain) } } : m));
}
