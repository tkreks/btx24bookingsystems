import type { ChatReactionDto } from '@btx24/shared';

/** Реакции под сообщением — только просмотр (поставить из приложения нельзя). */
export function Reactions({ items }: { items: ChatReactionDto[] | undefined }) {
  if (!items?.length) return null;
  return (
    <div className="msg-reactions">
      {items.map((r) => (
        <span key={r.emoji} className={`msg-reaction${r.mine ? ' mine' : ''}`} title={r.mine ? (r.count > 1 ? 'Клиент и вы (с телефона)' : 'Вы (с телефона)') : 'Клиент'}>
          {r.emoji}
          {r.count > 1 && <b>{r.count}</b>}
        </span>
      ))}
    </div>
  );
}
