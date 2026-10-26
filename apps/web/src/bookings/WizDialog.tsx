import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Модальное окно внутри мастера брони: нативный dialog (фокус внутри, Esc закрывает). Enter и клики не
 * уходят в форму мастера — иначе Enter в поиске отправил бы раздел, а клик закрыл бы мастер.
 */
export function WizDialog({ title, wide = false, onClose, onEnter, children }: { title: string; wide?: boolean; onClose: () => void; onEnter?: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`wz-time-dialog wz-dialog${wide ? ' wide' : ''}`}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' || (e.target as HTMLElement).tagName === 'BUTTON') return;
        e.preventDefault();
        e.stopPropagation();
        onEnter?.();
      }}
    >
      <header className="wz-dialog-head">
        <h3>{title}</h3>
        <button type="button" className="bk-close" aria-label="Закрыть" onClick={onClose}>
          ×
        </button>
      </header>
      {children}
    </dialog>
  );
}
