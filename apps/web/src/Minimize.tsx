import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** Общая «полка» свёрнутых окон внизу экрана (создаётся при первом свёрнутом окне). */
function dock(): HTMLElement {
  let el = document.getElementById('minimized-dock');
  if (!el) {
    el = document.createElement('div');
    el.id = 'minimized-dock';
    el.className = 'minimized-dock';
    el.setAttribute('aria-label', 'Свёрнутые окна');
    document.body.appendChild(el);
  }
  return el;
}

/**
 * «Свернуть» для модального окна (решение владельца 2026-10-23): кнопка в шапке прячет окно — сам
 * компонент окна остаётся на месте, поэтому введённое не теряется, — а внизу экрана появляется плашка
 * «Развернуть». Пока окно свёрнуто, Escape его не закрывает (сначала развернуть). Ставится внутрь
 * `.sheet-backdrop` окна; прячется ближайший такой фон.
 */
export function MinimizeButton({ label }: { label: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [minimized, setMinimized] = useState(false);

  useEffect(() => {
    const backdrop = ref.current?.closest('.sheet-backdrop');
    backdrop?.classList.toggle('minimized', minimized);
    if (!minimized) return;
    // Свёрнутое окно не реагирует на Escape: обработчики окон висят на document, этот — раньше.
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') e.stopPropagation();
    };
    window.addEventListener('keydown', esc, true);
    return () => window.removeEventListener('keydown', esc, true);
  }, [minimized]);
  // Окно закрыли свёрнутым (например, по завершении) — снять отметку с фона.
  useEffect(() => () => ref.current?.closest('.sheet-backdrop')?.classList.remove('minimized'), []);

  return (
    <>
      <button
        ref={ref}
        type="button"
        className="sheet-minimize"
        aria-label={`Свернуть «${label}»`}
        title="Свернуть — заполненное сохранится"
        onClick={(e) => {
          e.stopPropagation();
          setMinimized(true);
        }}
      >
        —
      </button>
      {minimized &&
        createPortal(
          <button type="button" className="minimized-chip" title="Развернуть" onClick={() => setMinimized(false)}>
            <span aria-hidden="true">▴</span> {label}
          </button>,
          dock(),
        )}
    </>
  );
}
