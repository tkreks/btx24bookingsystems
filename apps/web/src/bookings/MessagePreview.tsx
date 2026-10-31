import { messagePreviewParts } from './message-preview.js';

/**
 * Текст сообщения клиенту с подставленными значениями (без переменных): место ссылки — плашкой,
 * срок оплаты — значением. Используется в окне оплаты и в просмотре счёта.
 */
export function MessagePreviewText({ text, deadlineText, link }: { text: string; deadlineText?: string; link?: string | null }) {
  const parts = messagePreviewParts(text, { deadlineText, link });
  return (
    <div className="pw-preview-text">
      {parts.map((p, i) =>
        p.kind === 'text' ? (
          <span key={i}>{p.text}</span>
        ) : (
          <span key={i} className={`pw-var ${p.kind}`} title={p.kind === 'link' ? 'Ссылка на оплату подставится при отправке' : 'Срок оплаты — с момента отправки'}>
            {p.text}
          </span>
        ),
      )}
    </div>
  );
}
