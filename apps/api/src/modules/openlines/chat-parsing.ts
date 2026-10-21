import type { ChatCrmLinks, ChatMessageDto, MessageAuthorKind } from '@btx24/shared';

/** Пользователь из ответа im.dialog.messages.get (нужные поля). */
export interface ImUser {
  id: number;
  name?: string;
  bot?: boolean;
  connector?: boolean;
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
 * Нет таких — самое свежее сообщение как есть (для превью); `human: false`.
 */
export function lastMeaningful(
  messages: ImMessage[],
  users: ImUser[],
): { message: ImMessage; kind: MessageAuthorKind; human: boolean } | null {
  const sorted = [...messages].sort((a, b) => b.id - a.id);
  for (const m of sorted) {
    const kind = authorKind(m.author_id, users);
    if (kind === 'client' || kind === 'employee') return { message: m, kind, human: true };
  }
  return sorted[0] ? { message: sorted[0], kind: authorKind(sorted[0].author_id, users), human: false } : null;
}

export function toMessageDto(m: ImMessage, users: ImUser[], files: ImFile[]): ChatMessageDto {
  const ids = new Set((m.params?.FILE_ID ?? []).map(Number));
  const kind = authorKind(m.author_id, users);
  const user = users.find((u) => Number(u.id) === Number(m.author_id));
  return {
    id: Number(m.id),
    date: m.date,
    author: { id: Number(m.author_id), name: kind === 'system' ? 'Система' : (user?.name ?? `#${m.author_id}`), kind },
    text: plainText(m.text),
    files: files
      .filter((f) => ids.has(Number(f.id)))
      .map((f) => ({
        id: Number(f.id),
        name: f.name ?? `Файл ${f.id}`,
        size: Number(f.size ?? 0),
        type: f.type ?? 'file',
        previewUrl: f.urlPreview || null,
        url: f.urlDownload || f.urlShow || null,
      })),
  };
}
