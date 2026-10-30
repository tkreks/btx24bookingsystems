import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
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
import { Icon } from '../openlines/icons.js';
import { BlockPreview } from './BlockPreview.js';
import { CATALOG_GROUPS, WIDTH_ICONS, WIDTH_SHARE, catalogCounts, filterCatalog, gridStep } from './block-catalog.js';

function useEscape(onClose: () => void) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
}

/** Стрелки по сетке карточек: число колонок берём из раскладки сетки. */
function gridKeys(grid: HTMLElement | null, e: ReactKeyboardEvent, index: number, length: number, focus: (i: number) => void) {
  const cols = grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length : 1;
  const next = gridStep(index, e.key, cols, length);
  if (next === null) return false;
  e.preventDefault();
  focus(next);
  return true;
}

function WidthTag({ width }: { width: BlockWidth }) {
  return (
    <span className="bcat-width-tag" title={`Ширина по умолчанию: ${BLOCK_WIDTH_LABELS[width].toLowerCase()}`}>
      <span className="bcat-width-mini" aria-hidden="true">
        <i style={{ width: `${WIDTH_SHARE[width] * 100}%` }} />
      </span>
      {WIDTH_ICONS[width]}
    </span>
  );
}

/** Карточка блока: эскиз, название, подсказка, ширина. */
function BlockCard({
  type,
  selected,
  onDash,
  action,
  note,
  tabIndex,
  onClick,
  onDoubleClick,
  onKeyDown,
  cardRef,
}: {
  type: DashboardBlockType;
  selected?: boolean;
  onDash?: boolean;
  action?: string;
  note?: string;
  tabIndex: number;
  onClick: () => void;
  onDoubleClick?: () => void;
  onKeyDown: (e: ReactKeyboardEvent) => void;
  cardRef?: (el: HTMLDivElement | null) => void;
}) {
  const m = DASHBOARD_BLOCKS[type];
  return (
    <div
      ref={cardRef}
      role="option"
      aria-selected={!!selected}
      aria-disabled={onDash || undefined}
      tabIndex={tabIndex}
      className={`bcat-card${selected ? ' selected' : ''}${onDash ? ' on-dash' : ''}`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
    >
      <div className="bcat-card-preview">
        <BlockPreview type={type} />
        {onDash && <span className="bcat-on-dash">✓ На дашборде</span>}
        {m.adminOnly && <span className="bcat-admin">администраторам</span>}
      </div>
      <div className="bcat-card-text">
        <b>{m.title}</b>
        <span className="muted">{note ?? m.hint}</span>
      </div>
      <div className="bcat-card-foot">
        <WidthTag width={m.width} />
        {action && <span className="bcat-card-action">{action}</span>}
      </div>
    </div>
  );
}

/** Выбор ширины: ряд из 6 колонок, подсвечена доля, которую займёт блок. */
function WidthPicker({ value, onChange, label }: { value: BlockWidth; onChange: (w: BlockWidth) => void; label: string }) {
  return (
    <div className="bcat-width-picker" role="radiogroup" aria-label={label}>
      {BLOCK_WIDTHS.map((w) => (
        <button key={w} type="button" role="radio" aria-checked={value === w} className={value === w ? 'active' : ''} title={BLOCK_WIDTH_LABELS[w]} onClick={() => onChange(w)}>
          <span className="bcat-row6" aria-hidden="true">
            {Array.from({ length: 6 }, (_, i) => (
              <span key={i} />
            ))}
            <i style={{ width: `${WIDTH_SHARE[w] * 100}%` }} />
          </span>
          <span className="bcat-width-name">
            <b>{WIDTH_ICONS[w]}</b> <span className="bcat-width-label">{BLOCK_WIDTH_LABELS[w]}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * Окно «Добавить блок» (решение владельца 2026-10-30): разделы слева, поиск, сетка карточек с эскизами,
 * справа — подробности выбранного блока, ширина на мини-сетке ряда и «Добавить на дашборд». Блоки, уже
 * стоящие на дашборде, видны с отметкой и не добавляются повторно. Двойной клик / Enter — добавить
 * сразу с шириной по умолчанию.
 */
export function BlockCatalog({
  available,
  used,
  onAdd,
  onClose,
}: {
  /** Все блоки, доступные сотруднику (включая уже выведенные). */
  available: DashboardBlockType[];
  used: ReadonlySet<DashboardBlockType>;
  onAdd: (t: DashboardBlockType, w: BlockWidth) => void;
  onClose: () => void;
}) {
  useEscape(onClose);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<DashboardBlockGroup | null>(null);
  const [widths, setWidths] = useState<Partial<Record<DashboardBlockType, BlockWidth>>>({});
  const list = useMemo(() => filterCatalog(available, query, group), [available, query, group]);
  const counts = useMemo(() => catalogCounts(available, query), [available, query]);
  const [picked, setPicked] = useState<DashboardBlockType | null>(() => filterCatalog(available, '', null).find((t) => !used.has(t)) ?? null);
  const [focusIdx, setFocusIdx] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);
  const cards = useRef<(HTMLDivElement | null)[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => searchRef.current?.focus({ preventScroll: true }), []);
  const free = available.filter((t) => !used.has(t)).length;
  const current = picked && list.includes(picked) ? picked : (list.find((t) => !used.has(t)) ?? list[0] ?? null);
  const tab = Math.min(focusIdx, Math.max(0, list.length - 1));
  const add = (t: DashboardBlockType, w?: BlockWidth) => {
    if (used.has(t)) return;
    onAdd(t, w ?? widths[t] ?? DASHBOARD_BLOCKS[t].width);
  };
  const focusCard = (i: number) => {
    setFocusIdx(i);
    cards.current[i]?.focus();
    cards.current[i]?.scrollIntoView({ block: 'nearest' });
  };
  const groups: (DashboardBlockGroup | null)[] = [null, ...CATALOG_GROUPS];
  const meta = current ? DASHBOARD_BLOCKS[current] : null;
  const width = current ? (widths[current] ?? DASHBOARD_BLOCKS[current].width) : 'half';
  return (
    <div className="sheet-backdrop bcat-backdrop" onClick={onClose}>
      <div className="sheet block-catalog bcat-sheet" role="dialog" aria-modal="true" aria-labelledby="bcat-title" onClick={(e) => e.stopPropagation()}>
        <header className="bcat-head">
          <div className="bcat-title">
            <h2 id="bcat-title">Добавить блок</h2>
            <span className="muted">
              Доступно {free} из {available.length} · выберите блок, ширину и добавьте на свой дашборд
            </span>
          </div>
          <label className="bcat-search">
            <Icon name="search" size={16} />
            <input
              ref={searchRef}
              type="search"
              placeholder="Поиск блока: звонки, брони, сделки…"
              aria-label="Поиск блока"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' && list.length) {
                  e.preventDefault();
                  focusCard(0);
                }
                if (e.key === 'Enter' && current) add(current);
              }}
            />
          </label>
          <MinimizeButton label="Добавить блок" />
          <button className="bcat-close" aria-label="Закрыть" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="bcat-body">
          <nav className="bcat-cats" aria-label="Разделы блоков">
            {groups.map((g) => {
              const n = g ? counts[g] : counts.all;
              return (
                <button key={g ?? 'all'} type="button" aria-pressed={group === g} className={group === g ? 'active' : ''} onClick={() => setGroup(g)}>
                  <span>{g ?? 'Все блоки'}</span>
                  <span className="bcat-count">{n}</span>
                </button>
              );
            })}
          </nav>
          <div className="bcat-grid-wrap">
            {!list.length && <p className="muted bcat-empty">Ничего не найдено{query ? ` по «${query}»` : ''}.</p>}
            {!free && <p className="notice bcat-all-used">Все доступные блоки уже на дашборде — уберите или замените блок, чтобы добавить другой.</p>}
            <div ref={gridRef} className="bcat-grid" role="listbox" aria-label="Блоки">
              {list.map((t, i) => (
                <BlockCard
                  key={t}
                  type={t}
                  selected={t === current}
                  onDash={used.has(t)}
                  tabIndex={i === tab ? 0 : -1}
                  cardRef={(el) => {
                    cards.current[i] = el;
                  }}
                  onClick={() => {
                    setPicked(t);
                    setFocusIdx(i);
                  }}
                  onDoubleClick={() => add(t, DASHBOARD_BLOCKS[t].width)}
                  onKeyDown={(e) => {
                    if (gridKeys(gridRef.current, e, i, list.length, focusCard)) return;
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      add(t, DASHBOARD_BLOCKS[t].width);
                    } else if (e.key === ' ') {
                      e.preventDefault();
                      setPicked(t);
                    }
                  }}
                />
              ))}
            </div>
          </div>
          <aside className="bcat-detail" aria-label="Выбранный блок" aria-live="polite">
            {current && meta ? (
              <>
                <div className="bcat-detail-preview">
                  <BlockPreview type={current} size="large" />
                </div>
                <div className="bcat-detail-text">
                  <span className="bcat-detail-group">{meta.group}</span>
                  <h3>{meta.title}</h3>
                  <p className="muted">{meta.hint}</p>
                </div>
                {used.has(current) ? (
                  <p className="notice bcat-detail-used">Блок уже на дашборде. Ширину можно поменять в настройке самого блока.</p>
                ) : (
                  <>
                    <div className="bcat-detail-label">
                      Ширина на дашборде <span className="muted">· {BLOCK_WIDTH_LABELS[width].toLowerCase()}</span>
                    </div>
                    <WidthPicker value={width} label={`Ширина: ${meta.title}`} onChange={(w) => setWidths({ ...widths, [current]: w })} />
                  </>
                )}
                <button type="button" className="primary bcat-add" disabled={used.has(current)} onClick={() => add(current)}>
                  {used.has(current) ? 'Уже на дашборде' : '+ Добавить на дашборд'}
                </button>
                <p className="muted bcat-tip">Двойной клик или Enter на карточке — добавить с шириной по умолчанию.</p>
              </>
            ) : (
              <p className="muted">Выберите блок слева.</p>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}

/** Окно «Заменить блок»: выведенные — поменяться местами и размерами; не выведенные — встать на место. */
export function ReplaceBlock({
  block,
  blocks,
  available,
  onPick,
  onClose,
}: {
  block: DashboardBlock;
  blocks: DashboardBlock[];
  available: DashboardBlockType[];
  onPick: (t: DashboardBlockType) => void;
  onClose: () => void;
}) {
  useEscape(onClose);
  const [query, setQuery] = useState('');
  const shown = blocks.filter((b) => b.id !== block.id && available.includes(b.type) && filterCatalog([b.type], query, null).length);
  const used = new Set(blocks.map((b) => b.type));
  const hidden = filterCatalog(
    available.filter((t) => !used.has(t)),
    query,
    null,
  );
  const sections: { title: string; items: { type: DashboardBlockType; action: string; note: string }[] }[] = [
    {
      title: 'На панели — поменяться местами и размерами',
      items: shown.map((b) => ({ type: b.type, action: 'Поменять', note: `Сейчас: ${BLOCK_WIDTH_LABELS[b.width].toLowerCase()}${b.rows === 2 ? ', два ряда' : ''}` })),
    },
    ...CATALOG_GROUPS.map((g) => ({
      title: `Не выведены · ${g}`,
      items: hidden.filter((t) => DASHBOARD_BLOCKS[t].group === g).map((t) => ({ type: t, action: 'Заменить', note: DASHBOARD_BLOCKS[t].hint })),
    })),
  ].filter((s) => s.items.length);
  const flat = sections.flatMap((s) => s.items);
  const [focusIdx, setFocusIdx] = useState(0);
  const cards = useRef<(HTMLDivElement | null)[]>([]);
  const firstGrid = useRef<HTMLDivElement>(null);
  const tab = Math.min(focusIdx, Math.max(0, flat.length - 1));
  const focusCard = (i: number) => {
    setFocusIdx(i);
    cards.current[i]?.focus();
    cards.current[i]?.scrollIntoView({ block: 'nearest' });
  };
  let n = 0;
  return (
    <div className="sheet-backdrop bcat-backdrop" onClick={onClose}>
      <div className="sheet block-catalog bcat-sheet bcat-replace" role="dialog" aria-modal="true" aria-labelledby="bcat-replace-title" onClick={(e) => e.stopPropagation()}>
        <header className="bcat-head">
          <div className="bcat-current">
            <span className="bcat-current-preview">
              <BlockPreview type={block.type} />
            </span>
            <div className="bcat-title">
              <h2 id="bcat-replace-title">Заменить «{DASHBOARD_BLOCKS[block.type].title}»</h2>
              <span className="muted">Выведенный блок поменяется с ним местами и размерами, новый — встанет на его место.</span>
            </div>
          </div>
          <label className="bcat-search">
            <Icon name="search" size={16} />
            <input
              type="search"
              placeholder="Поиск блока"
              aria-label="Поиск блока"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' && flat.length) {
                  e.preventDefault();
                  focusCard(0);
                }
              }}
            />
          </label>
          <button className="bcat-close" aria-label="Закрыть" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="bcat-replace-body">
          {sections.map((s, si) => (
            <section key={s.title} className="bcat-section">
              <h3>{s.title}</h3>
              <div ref={si === 0 ? firstGrid : undefined} className="bcat-grid" role="listbox" aria-label={s.title}>
                {s.items.map((it) => {
                  const i = n++;
                  return (
                    <BlockCard
                      key={it.type}
                      type={it.type}
                      action={it.action}
                      note={it.note}
                      tabIndex={i === tab ? 0 : -1}
                      cardRef={(el) => {
                        cards.current[i] = el;
                      }}
                      onClick={() => onPick(it.type)}
                      onKeyDown={(e) => {
                        if (gridKeys(firstGrid.current, e, i, flat.length, focusCard)) return;
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onPick(it.type);
                        }
                      }}
                    />
                  );
                })}
              </div>
            </section>
          ))}
          {!flat.length && <p className="muted bcat-empty">{query ? `Ничего не найдено по «${query}».` : 'Других блоков нет.'}</p>}
        </div>
      </div>
    </div>
  );
}
