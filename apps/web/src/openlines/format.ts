import type { MessageAuthorKind } from '@btx24/shared';

const CONNECTORS: [RegExp, string][] = [
  [/whatsapp/i, 'WhatsApp'],
  [/telegram/i, 'Telegram'],
  [/viber/i, 'Viber'],
  [/(^|_)vk|vkgroup/i, 'ВКонтакте'],
  [/avito/i, 'Авито'],
  [/instagram|fbinstagram/i, 'Instagram'],
  [/facebook/i, 'Facebook'],
  [/livechat/i, 'Онлайн-чат'],
  [/imessage/i, 'iMessage'],
  [/max/i, 'MAX'],
  [/email|mail/i, 'E-mail'],
];

/** Код коннектора открытой линии → название канала для людей. */
export function connectorLabel(code: string): string {
  return CONNECTORS.find(([re]) => re.test(code))?.[1] ?? (code || 'Канал');
}

/** Время сообщения в списке: сегодня — «14:05», иначе — «20.10». В часовом поясе портала. */
export function shortTime(iso: string, timeZone: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const day = (x: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone }).format(x);
  const opts: Intl.DateTimeFormatOptions =
    day(d) === day(now) ? { hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: '2-digit' };
  return new Intl.DateTimeFormat('ru-RU', { timeZone, ...opts }).format(d);
}

export const AUTHOR_PREFIX: Record<MessageAuthorKind, string> = {
  client: '',
  employee: 'Оператор: ',
  bot: 'Бот: ',
  system: '',
};

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

/** Имя клиента в чатах — не длиннее `max` символов (полное — в подсказке). */
export function clipName(name: string, max = 15): string {
  const chars = [...name.trim()];
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : name.trim();
}
