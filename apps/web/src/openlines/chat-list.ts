import type { ChatSummary } from '@btx24/shared';
import { connectorLabel } from './format.js';

export type ChatTab = 'all' | 'waiting' | 'answered';
export type ChatSort = 'recent' | 'waiting' | 'name';

export const CHAT_SORTS: { key: ChatSort; label: string }[] = [
  { key: 'recent', label: 'Сначала новые' },
  { key: 'waiting', label: 'Сначала ждут ответа' },
  { key: 'name', label: 'По имени А–Я' },
];

/**
 * Вкладка и поиск по уже загруженным чатам: имя, канал, текст последнего сообщения и номер
 * телефона клиента (по цифрам, любой частью: «985 12» найдёт +7 985 123-…).
 */
export function visibleChats(items: ChatSummary[], tab: ChatTab, query: string, sort: ChatSort): ChatSummary[] {
  const q = query.trim().toLocaleLowerCase('ru');
  const digits = phoneDigits(q);
  const shown = items.filter((c) => {
    if (tab === 'waiting' && !c.waitingReply) return false;
    if (tab === 'answered' && c.waitingReply) return false;
    if (!q) return true;
    if (digits.length >= 3 && (c.phones ?? []).some((p) => phoneDigits(p).includes(digits))) return true;
    return [c.title, connectorLabel(c.connector), c.lastMessage?.preview ?? ''].join(' ').toLocaleLowerCase('ru').includes(q);
  });
  // «Сначала новые» — порядок сервера (как в списке диалогов Битрикс24); сортировка устойчивая.
  if (sort === 'name') return [...shown].sort((a, b) => a.title.localeCompare(b.title, 'ru'));
  if (sort === 'waiting') return [...shown].sort((a, b) => Number(b.waitingReply) - Number(a.waitingReply));
  return shown;
}

/** «Артём» → «А», «Максим Тармосин» → «МТ»; без букв — «#». */
export function initials(title: string): string {
  const words = title.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '#';
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0][0]).toLocaleUpperCase('ru');
}

/** Постоянный цвет аватара чата: 1…9. */
export function avatarTone(id: number): number {
  return (Math.abs(id) % 9) + 1;
}

/** Склонение: 1 чат, 2 чата, 5 чатов. */
export function chatsCount(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  const word = m10 === 1 && m100 !== 11 ? 'чат' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'чата' : 'чатов';
  return `${n} ${word}`;
}

/** Ключ дня сообщения (YYYY-MM-DD в поясе портала) — для разделителей ленты. */
export function dayKey(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone }).format(new Date(iso));
}

/** Цифры номера без кода страны в начале (+7 / 8): «8 (985) 123» → «985123». */
export function phoneDigits(v: string): string {
  const d = v.replace(/\D/g, '');
  return d.length >= 11 && (d[0] === '7' || d[0] === '8') ? d.slice(1) : d;
}

/** Похоже на полный номер — искать по всему порталу. */
export function isFullPhone(q: string): boolean {
  const d = q.replace(/\D/g, '');
  return d.length >= 10 && d.length <= 15 && /^[\d\s+()-]+$/.test(q.trim());
}
