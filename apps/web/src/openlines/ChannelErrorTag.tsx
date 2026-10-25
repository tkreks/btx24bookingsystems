/** Красный треугольник с «!» — ошибка канала. */
export function ErrorTriangle({ size = 14 }: { size?: number }) {
  return (
    <svg className="error-triangle" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10.3 3.4a2 2 0 0 1 3.4 0l8.4 14.6a2 2 0 0 1-1.7 3H3.6a2 2 0 0 1-1.7-3Z" fill="currentColor" />
      <path d="M12 8.5v5.5" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="12" cy="17.4" r="1.4" fill="#fff" />
    </svg>
  );
}

/** Тег «Ошибка» рядом с именем клиента в списке чатов (Wazzup сообщил: канал выключен). */
export function ChannelErrorTag() {
  return (
    <span className="channel-error-tag" title="Wazzup сообщил: канал выключен. Откройте чат и начните новый диалог через подключение приложения.">
      <ErrorTriangle size={12} />
      Ошибка
    </span>
  );
}
