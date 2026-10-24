import { useEffect, useState, type ReactNode } from 'react';
import {
  BLOCK_WIDTH_LABELS,
  BLOCK_WIDTHS,
  DASHBOARD_BLOCKS,
  type BlockWidth,
  type DashboardBlock,
  type DashboardBlockGroup,
  type DashboardBlockType,
} from '@btx24/shared';
import { MinimizeButton } from '../Minimize.js';
import { BlockSync } from './DashboardSync.js';
import { Icon } from '../openlines/icons.js';
import { replaceBlock } from './replace-block.js';

const WIDTH_ICONS: Record<BlockWidth, string> = { sixth: '⅙', fifth: '⅕', quarter: '¼', third: '⅓', half: '½', full: '▭' };
const GROUPS: DashboardBlockGroup[] = ['Показатели', 'Списки', 'По дням и сравнение', 'Контроль'];

/**
 * Сетка личного дашборда (решение владельца 2026-10-24): 60 колонок — шестая часть (10), пятая (12), четверть (15), треть (20), половина
 * (30), весь ряд (60); на планшете четверть и треть — по половине, на телефоне все — во всю ширину. В режиме
 * настройки у блока — перетаскивание и стрелки (порядок), ширина, высота (↕ — два ряда), «убрать»; в конце — «+ Добавить блок».
 */
export function BlockGrid({
  blocks,
  editing,
  available,
  render,
  sources,
  onChange,
}: {
  blocks: DashboardBlock[];
  editing: boolean;
  /** Блоки, которые сотрудник может добавить (без «только администраторам» для остальных). */
  available: DashboardBlockType[];
  render: (b: DashboardBlock) => ReactNode;
  /** Запросы страницы, из которых блок взял данные — подпись «из кэша / обновлено». */
  sources?: (b: DashboardBlock) => string[];
  onChange: (blocks: DashboardBlock[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [replacing, setReplacing] = useState<DashboardBlock | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const move = (from: number, to: number) => {
    if (to < 0 || to >= blocks.length || from === to) return;
    const next = [...blocks];
    const [b] = next.splice(from, 1);
    next.splice(to, 0, b);
    onChange(next);
  };
  const used = new Set(blocks.map((b) => b.type));
  return (
    <>
      <div className={`dash-grid${editing ? ' editing' : ''}`}>
        {blocks.map((b, i) => {
          const content = render(b);
          // Блок без данных у сотрудника (нет открытых линий и т. п.) — вне настройки не показываем.
          if (!content && !editing) return null;
          return (
            <div
              key={b.id}
              data-dashboard-anchor={`block:${b.id}`}
              className={`dash-cell w-${b.width}${b.rows === 2 ? ' h-2' : ''}${drag === i ? ' dragging' : ''}`}
              draggable={editing}
              onDragStart={() => setDrag(i)}
              onDragEnd={() => setDrag(null)}
              onDragOver={(e) => editing && e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (drag !== null) move(drag, i);
                setDrag(null);
              }}
            >
              {editing && (
                <div className="dash-cell-tools" role="group" aria-label={`Блок «${DASHBOARD_BLOCKS[b.type].title}»`}>
                  <span className="dash-cell-name" title="Перетащите, чтобы поменять место">
                    ⠿ {DASHBOARD_BLOCKS[b.type].title}
                  </span>
                  <button type="button" aria-label="Раньше" title="Раньше" disabled={!i} onClick={() => move(i, i - 1)}>
                    ←
                  </button>
                  <button type="button" aria-label="Позже" title="Позже" disabled={i === blocks.length - 1} onClick={() => move(i, i + 1)}>
                    →
                  </button>
                  <span className="segmented dash-width" role="radiogroup" aria-label="Ширина блока">
                    {BLOCK_WIDTHS.map((w) => (
                      <button
                        key={w}
                        type="button"
                        role="radio"
                        aria-checked={b.width === w}
                        className={b.width === w ? 'active' : ''}
                        title={BLOCK_WIDTH_LABELS[w]}
                        aria-label={BLOCK_WIDTH_LABELS[w]}
                        onClick={() => onChange(blocks.map((x) => (x.id === b.id ? { ...x, width: w } : x)))}
                      >
                        {WIDTH_ICONS[w]}
                      </button>
                    ))}
                  </span>
                  <button
                    type="button"
                    className={`dash-height${b.rows === 2 ? ' active' : ''}`}
                    aria-pressed={b.rows === 2}
                    aria-label="Высота: два ряда"
                    title={b.rows === 2 ? 'Высота — два ряда (нажмите, чтобы вернуть один)' : 'Растянуть на высоту двух рядов'}
                    onClick={() => onChange(blocks.map((x) => (x.id === b.id ? { ...x, rows: x.rows === 2 ? 1 : 2 } : x)))}
                  >
                    ↕
                  </button>
                  <button type="button" className="dash-cell-swap" aria-label={`Заменить блок «${DASHBOARD_BLOCKS[b.type].title}»`} title="Заменить на другой блок или поменять местами" onClick={() => setReplacing(b)}>
                    <Icon name="swap" size={16} />
                  </button>
                  <button type="button" className="dash-cell-remove" aria-label="Убрать блок" title="Убрать с дашборда" onClick={() => onChange(blocks.filter((x) => x.id !== b.id))}>
                    ×
                  </button>
                </div>
              )}
              <div className="dash-cell-body">{content ? <BlockSync paths={sources?.(b)}>{content}</BlockSync> : <p className="muted dash-cell-empty">Блок недоступен: нет прав или данных.</p>}</div>
            </div>
          );
        })}
        {editing && (
          <button type="button" className="dash-cell w-quarter dash-add" onClick={() => setAdding(true)}>
            + Добавить блок
          </button>
        )}
      </div>
      {replacing && (
        <ReplaceBlock
          block={replacing}
          blocks={blocks}
          available={available}
          onClose={() => setReplacing(null)}
          onPick={(type) => {
            const next = replaceBlock(blocks, replacing.id, type);
            setReplacing(null);
            onChange(next);
          }}
        />
      )}
      {adding && (
        <BlockCatalog
          available={available.filter((t) => !used.has(t))}
          onClose={() => setAdding(false)}
          onAdd={(type, width) => {
            onChange([...blocks, { id: `${type}-${Date.now().toString(36)}`, type, width }]);
            setAdding(false);
          }}
        />
      )}
    </>
  );
}

/** Каталог блоков по разделам: описание и ширина при добавлении. */
function BlockCatalog({ available, onAdd, onClose }: { available: DashboardBlockType[]; onAdd: (t: DashboardBlockType, w: BlockWidth) => void; onClose: () => void }) {
  const [widths, setWidths] = useState<Partial<Record<DashboardBlockType, BlockWidth>>>({});
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet block-catalog" role="dialog" aria-modal="true" aria-label="Добавить блок" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Добавить блок</h2>
          <MinimizeButton label="Добавить блок" />
          <button aria-label="Закрыть" onClick={onClose}>
            ×
          </button>
        </header>
        {!available.length && <p className="muted">Все доступные блоки уже на дашборде.</p>}
        {GROUPS.map((g) => {
          const list = available.filter((t) => DASHBOARD_BLOCKS[t].group === g);
          if (!list.length) return null;
          return (
            <section key={g} className="block-catalog-group">
              <h3>{g}</h3>
              <ul>
                {list.map((t) => {
                  const w = widths[t] ?? DASHBOARD_BLOCKS[t].width;
                  return (
                    <li key={t}>
                      <span className="block-catalog-main">
                        <b>{DASHBOARD_BLOCKS[t].title}</b>
                        <span className="muted">{DASHBOARD_BLOCKS[t].hint}</span>
                      </span>
                      <span className="segmented dash-width" role="radiogroup" aria-label={`Ширина: ${DASHBOARD_BLOCKS[t].title}`}>
                        {BLOCK_WIDTHS.map((x) => (
                          <button key={x} type="button" role="radio" aria-checked={w === x} className={w === x ? 'active' : ''} title={BLOCK_WIDTH_LABELS[x]} aria-label={BLOCK_WIDTH_LABELS[x]} onClick={() => setWidths({ ...widths, [t]: x })}>
                            {WIDTH_ICONS[x]}
                          </button>
                        ))}
                      </span>
                      <button type="button" className="primary" onClick={() => onAdd(t, w)}>
                        Добавить
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** Окно «Заменить блок»: выведенные — поменяться местами и размерами; не выведенные — встать на место. */
function ReplaceBlock({ block, blocks, available, onPick, onClose }: { block: DashboardBlock; blocks: DashboardBlock[]; available: DashboardBlockType[]; onPick: (t: DashboardBlockType) => void; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  const shown = blocks.filter((b) => b.id !== block.id && available.includes(b.type));
  const used = new Set(blocks.map((b) => b.type));
  const hidden = available.filter((t) => !used.has(t));
  const row = (t: DashboardBlockType, action: string, hint: string) => (
    <li key={t}>
      <span className="block-catalog-main">
        <b>{DASHBOARD_BLOCKS[t].title}</b>
        <span className="muted">{hint}</span>
      </span>
      <button type="button" className="primary" onClick={() => onPick(t)}>
        {action}
      </button>
    </li>
  );
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet block-catalog" role="dialog" aria-modal="true" aria-label="Заменить блок" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Заменить «{DASHBOARD_BLOCKS[block.type].title}»</h2>
          <button aria-label="Закрыть" onClick={onClose}>
            ×
          </button>
        </header>
        {!!shown.length && (
          <section className="block-catalog-group">
            <h3>На панели — поменяться местами и размерами</h3>
            <ul>{shown.map((b) => row(b.type, 'Поменять', `${BLOCK_WIDTH_LABELS[b.width].toLowerCase()}${b.rows === 2 ? ', два ряда' : ''}`))}</ul>
          </section>
        )}
        {GROUPS.map((g) => {
          const list = hidden.filter((t) => DASHBOARD_BLOCKS[t].group === g);
          if (!list.length) return null;
          return (
            <section key={g} className="block-catalog-group">
              <h3>Не выведены · {g}</h3>
              <ul>{list.map((t) => row(t, 'Заменить', DASHBOARD_BLOCKS[t].hint))}</ul>
            </section>
          );
        })}
        {!shown.length && !hidden.length && <p className="muted">Других блоков нет.</p>}
      </div>
    </div>
  );
}
