import { useEffect, useRef, useState } from 'react';
import { Icon } from '../openlines/icons.js';

/** Три вертикальные точки. */
function DotsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <circle cx="12" cy="5.5" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="12" cy="18.5" r="1.8" />
    </svg>
  );
}

/**
 * «⋮» в конце строки чата (дашборд, встройка сделки; решение владельца 2026-10-26): по нажатию — «Сделка»,
 * «Перейти в чат», «Скрыть с дашборда». Меню — `position: fixed` у кнопки: блоки дашборда обрезают
 * содержимое по своей высоте.
 */
export function ChatRowMenu({ dealId, onDeal, onChat, onHide }: { dealId: number | null; onDeal: () => void; onChat: () => void; onHide: () => void }) {
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!at) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setAt(null);
    };
    const drop = () => setAt(null);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    window.addEventListener('scroll', drop, true);
    window.addEventListener('resize', drop);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
      window.removeEventListener('scroll', drop, true);
      window.removeEventListener('resize', drop);
    };
  }, [at]);
  const toggle = () => {
    if (at) return setAt(null);
    const r = button.current?.getBoundingClientRect();
    if (r) setAt({ top: Math.min(r.bottom + 4, window.innerHeight - 140), right: Math.max(8, window.innerWidth - r.right) });
  };
  const pick = (fn: () => void) => () => {
    setAt(null);
    fn();
  };
  return (
    <>
      <button ref={button} className="dash-icon-btn" title="Действия с чатом" aria-label="Действия с чатом" aria-haspopup="menu" aria-expanded={!!at} onClick={toggle}>
        <DotsIcon />
      </button>
      {at && (
        <div ref={menu} className="cl-menu chat-row-menu" role="menu" style={{ top: at.top, right: at.right }}>
          <button role="menuitem" className="cl-menu-item" disabled={!dealId} title={dealId ? `Сделка #${dealId}` : 'Чат не привязан к сделке'} onClick={pick(onDeal)}>
            <Icon name="deal" size={16} /> Сделка
          </button>
          <button role="menuitem" className="cl-menu-item" onClick={pick(onChat)}>
            <Icon name="gochat" size={16} /> Перейти в чат
          </button>
          <button role="menuitem" className="cl-menu-item" onClick={pick(onHide)}>
            <Icon name="hide" size={16} /> Скрыть с дашборда
          </button>
        </div>
      )}
    </>
  );
}
