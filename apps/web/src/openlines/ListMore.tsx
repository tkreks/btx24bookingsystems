import { Icon } from './icons.js';

/**
 * Низ списка блока дашборда: «Показать ещё · 5 из 12» (добавляет `step` строк) и «Свернуть», когда
 * показано всё. Строка во всю ширину блока, как сами строки списка, — без отдельной «таблетки».
 */
export function ListMore({ total, shown, step, onShow }: { total: number; shown: number; step: number; onShow: (n: number) => void }) {
  if (total <= step) return null;
  const all = shown >= total;
  return (
    <button className="list-more" aria-expanded={all} onClick={() => onShow(all ? step : shown + step)}>
      <span>{all ? 'Свернуть' : 'Показать ещё'}</span>
      <Icon name={all ? 'chevronUp' : 'chevronDown'} size={16} />
      <span className="list-more-count">
        {Math.min(shown, total)} из {total}
      </span>
    </button>
  );
}
