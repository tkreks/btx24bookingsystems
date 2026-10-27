import { messageChannel } from '@btx24/shared';
import type { ChatCrmLinks } from '@btx24/shared';

/**
 * Переписка (ADR 0017) = клиент × наш канал. Все чаты открытых линий с одним ключом — один чат в
 * приложении: Wazzup и наш коннектор на одном номере, повторные диалоги, бывшие чаты сделок (`::deal:`).
 */

/** Части `entity_id` чата открытой линии: `<connector>|<line>|<внешний чат>|<внешний пользователь>`. */
export function entityParts(entityId: string | null | undefined): { lineId: number | null; extChatId: string | null } {
  const [, line, chat] = String(entityId ?? '').split('|');
  const lineId = Number(line);
  // Чат сделки (`<чат>::deal:<id>`) — тот же собеседник.
  const ext = (chat ?? '').split('::deal:')[0]?.trim() ?? '';
  return { lineId: Number.isSafeInteger(lineId) && lineId > 0 ? lineId : null, extChatId: ext ? ext.slice(0, 190) : null };
}

/** Группа мессенджера — своя переписка, не переписка с контактом, к которому её привязала линия. */
export function isGroupChat(extChatId: string | null | undefined): boolean {
  return (extChatId ?? '').endsWith('@g.us');
}

/** Канал линии без явного соответствия: своя переписка у каждой линии. */
export const lineChannel = (lineId: number) => `line:${lineId}`;

export interface OwnNumber {
  kind: string;
  phone: string;
  lineId: number | null;
}

/**
 * Канал линии по умолчанию: линия своего номера — `<вид>:<номер>`; линия, в названии которой есть
 * не меньше четырёх последних цифр нашего номера того же вида (`WAZZUP - БК Алатырь (7272)`), — тот же
 * номер; иначе — отдельный канал линии.
 */
export function autoChannel(line: { id: number; name: string; connectors?: string[] }, own: OwnNumber[]): string {
  const bound = own.find((n) => n.lineId === line.id);
  if (bound) return `${bound.kind}:${bound.phone}`;
  const kinds = new Set((line.connectors ?? []).map(messageChannel));
  const digits = line.name.match(/\d{4,}/g) ?? [];
  const byName = own.filter((n) => (!kinds.size || kinds.has(n.kind)) && digits.some((d) => n.phone.endsWith(d)));
  return byName.length === 1 ? `${byName[0].kind}:${byName[0].phone}` : lineChannel(line.id);
}

/** Клиент переписки: контакт, затем компания, лид; без CRM — собеседник линии (внешний чат). */
export function clientKey(crm: ChatCrmLinks | null | undefined, extChatId: string | null, chatId: number): string {
  if (isGroupChat(extChatId)) return `x:${extChatId}`;
  if (crm?.contactId) return `c:${crm.contactId}`;
  if (crm?.companyId) return `co:${crm.companyId}`;
  if (crm?.leadId) return `l:${crm.leadId}`;
  return extChatId ? `x:${extChatId}` : `chat:${chatId}`;
}

/**
 * Ключ переписки чата. Канал — по линии (соответствие `ChatLineChannel`), без линии — по виду
 * коннектора. Ключ ограничен 191 символом (индекс).
 */
export function conversationKey(
  chat: { chatId: number; crm: ChatCrmLinks | null | undefined; connector: string; lineId: number | null; extChatId: string | null },
  channels: Map<number, string>,
): string {
  const channel = chat.lineId ? (channels.get(chat.lineId) ?? lineChannel(chat.lineId)) : `connector:${messageChannel(chat.connector)}`;
  return `${channel}|${clientKey(chat.crm, chat.extChatId, chat.chatId)}`.slice(0, 191);
}

/** Ключ переписки для чата без ключа (ещё не обработан worker'ом) — сам по себе. */
export const ownKey = (chatId: number) => `chat:${chatId}`;

/** Наш канал из ключа переписки (`whatsapp:7499…`, `line:2`, `connector:telegram`). */
export const channelOfKey = (key: string) => key.split('|')[0] ?? key;
