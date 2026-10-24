import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './icons.js';

/** Сколько строк добавлять за проход, пока блок в два ряда не заполнится (защита от зацикливания). */
const MAX_FILL_STEPS = 200;

/**
 * Низ списка блока дашборда: «Показать ещё · 5 из 12» (добавляет `step` строк) и «Свернуть», когда
 * показано всё. Строка во всю ширину блока, как сами строки списка, — без отдельной «таблетки».
 *
 * В блоке высотой в два ряда (`.dash-cell.h-2`) список сам дополняется строками, пока они помещаются
 * в высоту блока данных; «Показать ещё» — дальше, «Свернуть» — обратно к заполненной высоте.
 */
export function ListMore({ total, shown, step, onShow }: { total: number; shown: number; step: number; onShow: (n: number) => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  /** Сколько строк помещается в высоту блока (0 — блок не в два ряда). */
  const [fit, setFit] = useState(0);
  const [tick, setTick] = useState(0);
  const filling = useRef(0);

  // Высота блока меняется (ширина окна, соседние блоки) — пересчитать заполнение.
  useEffect(() => {
    const panel = ref.current?.closest('.dash-cell.h-2');
    if (!panel || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setTick((t) => t + 1));
    ro.observe(panel);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const anchor = ref.current;
    const tall = anchor?.closest('.dash-cell.h-2');
    const panel = tall ? anchor!.closest<HTMLElement>('.dash-cell-body > *') : null;
    if (!panel) {
      // Блок снова в один ряд — обычное число строк.
      if (fit) {
        setFit(0);
        if (shown === fit) onShow(step);
      }
      return;
    }
    // Заполняем только «базовую» высоту: развёрнутое сотрудником дальше не трогаем.
    if (shown !== Math.max(fit, step) || shown >= total || filling.current > MAX_FILL_STEPS) return;
    const box = panel.getBoundingClientRect();
    const bottom = box.bottom - parseFloat(getComputedStyle(panel).paddingBottom || '0');
    const contentBottom = Math.max(...[...panel.children].map((c) => c.getBoundingClientRect().bottom));
    const rows = panel.querySelectorAll('li');
    const rowHeight = rows.length ? rows[rows.length - 1].getBoundingClientRect().height : 40;
    if (rowHeight > 0 && bottom - contentBottom >= rowHeight) {
      filling.current++;
      setFit(shown + 1);
      onShow(shown + 1);
    } else filling.current = 0;
  }, [shown, total, step, fit, tick, onShow]);

  const base = Math.max(step, fit);
  if (total <= base) return <span ref={ref} hidden />;
  const all = shown >= total;
  return (
    <>
      <span ref={ref} hidden />
      <button className="list-more" aria-expanded={all} onClick={() => onShow(all ? base : shown + step)}>
        <span>{all ? 'Свернуть' : 'Показать ещё'}</span>
        <Icon name={all ? 'chevronUp' : 'chevronDown'} size={16} />
        <span className="list-more-count">
          {Math.min(shown, total)} из {total}
        </span>
      </button>
    </>
  );
}
