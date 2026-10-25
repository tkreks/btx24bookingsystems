import { todayIn, type AttentionChatDto } from '@btx24/shared';
import { fmtDate, fmtTime, shiftDate } from '../format.js';
import { Avatar } from '../openlines/Avatar.js';
import { Channel } from '../openlines/Channel.js';
import { avatarTone } from '../openlines/chat-list.js';

export function messageDay(at: string, timezone: string, now = new Date()): string {
  const today = todayIn(timezone, now);
  const date = todayIn(timezone, new Date(at));
  return date === today ? 'сегодня' : date === shiftDate(today, -1) ? 'вчера' : fmtDate(at, timezone);
}
/** Метка в пузыре сообщения: сегодня — только время, вчера — «вчера 14:05», раньше — «22.10 14:05» (другой год — с годом). */
export function messageStamp(at: string, timezone: string, now = new Date()): string {
  const day = messageDay(at, timezone, now);
  const time = fmtTime(at, timezone);
  if (day === 'сегодня') return time;
  if (day === 'вчера') return `вчера ${time}`;
  const sameYear = todayIn(timezone, now).slice(0, 4) === todayIn(timezone, new Date(at)).slice(0, 4);
  return `${sameYear ? day.slice(0, 5) : day} ${time}`;
}
export function messageLayers(unread: number): number {
  return Math.min(4, Math.max(1, Number.isFinite(unread) ? Math.trunc(unread) : 1));
}
export function AttentionMessage({ chat, timezone, onOpen }: { chat: AttentionChatDto; timezone: string; onOpen: () => void }) {
  const name = chat.clientName || chat.title;
  const unread = Math.max(0, Number.isFinite(chat.unread) ? Math.trunc(chat.unread) : 0);
  const preview = chat.preview || (chat.hasFiles ? '📎 Файл' : 'Сообщение клиента');
  return <button type="button" className="attention-row" onClick={onOpen}>
    <span className="attention-title">
      <Channel connector={chat.connector} />
      <span className="attention-avatar"><Avatar src={chat.clientAvatar} name={name} size={26} tone={avatarTone(chat.chatId)} /></span>
      <span className="attention-name" title={name}>{name}</span>
    </span>
    <span className="attention-message-space"><span className={`attention-message-stack layers-${messageLayers(unread)}`}>
      {Array.from({ length: messageLayers(unread) - 1 }, (_, i) => <span key={i} className="attention-message-layer" style={{ transform: `translate(${(i + 1) * 2}px, ${(i + 1) * 2}px)` }} aria-hidden="true" />)}
      <span className="attention-preview" title={preview}>
        <span className="attention-preview-text">{preview}</span>
        {chat.lastMessageAt && <time className="attention-stamp" dateTime={chat.lastMessageAt}>{messageStamp(chat.lastMessageAt, timezone)}</time>}
      </span>
      {unread > 0 && <span className="attention-unread" title="Непрочитанных сообщений клиента" aria-label={`Непрочитанных сообщений: ${unread}`}>{unread > 99 ? '99+' : unread}</span>}
    </span></span>
  </button>;
}
