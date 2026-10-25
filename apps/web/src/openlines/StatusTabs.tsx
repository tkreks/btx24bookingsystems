import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ChatTab } from './chat-list.js';
import { Icon, type IconName } from './icons.js';

type Category = Exclude<ChatTab, 'all'>;

/** Категории чатов (решение владельца 2026-10-25): «Все» — значок ∞, категории — пока помещаются, остальные — за кнопкой ⇅. */
export const CATEGORIES: { key: Category; label: string; icon: IconName }[] = [
  { key: 'waiting', label: 'Без ответа', icon: 'hourglass' },
  { key: 'booked', label: 'Брони', icon: 'calendar' },
  { key: 'payment', label: 'Оплата', icon: 'coin' },
];

/**
 * Сколько категорий показать в ряд: ширины кнопок `widths` по порядку; если не все — нужна кнопка ⇅
 * шириной `more`. `room` — место после «Все» (и вкладки клиента), `gap` — промежуток между кнопками.
 */
export function fitCategories(widths: number[], more: number, room: number, gap: number): number {
  for (let k = widths.length; k >= 0; k--) {
    const need = widths.slice(0, k).reduce((s, w) => s + w + gap, 0) + (k < widths.length ? more + gap : 0);
    if (need <= room) return k;
  }
  return 0;
}

export function StatusTabs({ tab, counts, loaded, onTab, leading }: {
  tab: string;
  counts: Partial<Record<ChatTab, number | null>>;
  loaded: boolean;
  onTab: (tab: ChatTab) => void;
  /** Вкладка клиента сделки — первой в ряду. */
  leading?: ReactNode;
}) {
  const nav = useRef<HTMLElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(CATEGORIES.length);
  const [menu, setMenu] = useState(false);
  const counter = (key: ChatTab) => (loaded ? (counts[key] ?? '—') : '…');

  useLayoutEffect(() => {
    const el = nav.current;
    const probe = measure.current;
    if (!el || !probe) return;
    const recalc = () => {
      const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
      const fixed = [...el.querySelectorAll<HTMLElement>(':scope > .cl-tab-fixed')].reduce((s, b) => s + b.offsetWidth + gap, 0);
      const buttons = [...probe.children] as HTMLElement[];
      const widths = buttons.slice(0, CATEGORIES.length).map((b) => b.offsetWidth);
      const more = buttons[CATEGORIES.length]?.offsetWidth ?? 0;
      setShown(fitCategories(widths, more, el.clientWidth - fixed, gap));
    };
    recalc();
    const ro = new ResizeObserver(recalc);
    ro.observe(el);
    return () => ro.disconnect();
  }, [leading, loaded, counts.waiting, counts.booked, counts.payment]);

  const visible = CATEGORIES.slice(0, shown);
  const hidden = CATEGORIES.slice(shown);
  const hiddenActive = hidden.find((c) => c.key === tab);
  const waitingHidden = hidden.some((c) => c.key === 'waiting') && !!counts.waiting;

  const button = (c: (typeof CATEGORIES)[number], probe = false) => (
    <button
      key={c.key}
      type="button"
      tabIndex={probe ? -1 : undefined}
      className={`cl-tab cl-tab-category${!probe && tab === c.key ? ' active' : ''}`}
      aria-pressed={probe ? undefined : tab === c.key}
      title={c.label}
      onClick={probe ? undefined : () => onTab(c.key)}
    >
      <Icon name={c.icon} size={15} />
      <span>{c.label}</span>
      <span className={`cl-tab-counter${c.key === 'waiting' && counts.waiting ? ' alert' : ''}`}>{counter(c.key)}</span>
    </button>
  );

  return (
    <nav ref={nav} className="cl-tabs cl-status-tabs" aria-label="Фильтр по статусу">
      {leading}
      <button
        type="button"
        className={`cl-tab cl-tab-icon cl-tab-fixed${tab === 'all' ? ' active' : ''}`}
        aria-pressed={tab === 'all'}
        aria-label="Все чаты"
        title="Все чаты"
        onClick={() => onTab('all')}
      >
        <Icon name="infinity" size={18} />
        <span className="cl-tab-counter">{counter('all')}</span>
      </button>
      {visible.map((c) => button(c))}
      {!!hidden.length && (
        <button
          type="button"
          className={`cl-tab cl-tab-icon${hiddenActive ? ' active' : ''}`}
          aria-label={`Категории чатов: ${hidden.map((c) => c.label).join(', ')}`}
          title={hidden.map((c) => `${c.label}: ${counter(c.key)}`).join('\n')}
          aria-haspopup="dialog"
          onClick={() => setMenu(true)}
        >
          {hiddenActive ? <Icon name={hiddenActive.icon} size={16} /> : <Icon name="updown" size={16} />}
          {hiddenActive ? <span className="cl-tab-counter">{counter(hiddenActive.key)}</span> : waitingHidden && <span className="cl-tab-counter alert">{counts.waiting}</span>}
        </button>
      )}
      <div ref={measure} className="cl-tabs-measure" aria-hidden="true">
        {CATEGORIES.map((c) => button(c, true))}
        <button type="button" tabIndex={-1} className="cl-tab cl-tab-icon">
          <Icon name="updown" size={16} />
          <span className="cl-tab-counter">00</span>
        </button>
      </div>
      {menu && <CategoryMenu items={hidden} tab={tab} counter={counter} onPick={(k) => { setMenu(false); onTab(k); }} onClose={() => setMenu(false)} />}
    </nav>
  );
}

function CategoryMenu({ items, tab, counter, onPick, onClose }: {
  items: typeof CATEGORIES;
  tab: string;
  counter: (key: ChatTab) => number | string;
  onPick: (key: Category) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => ref.current?.showModal(), []);
  return (
    <dialog ref={ref} className="new-dialog cl-category-menu" aria-label="Категории чатов" onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <header className="new-dialog-head">
        <h3>Категории чатов</h3>
        <button type="button" className="new-dialog-close" aria-label="Закрыть" onClick={onClose}>×</button>
      </header>
      <ul>
        {items.map((c) => (
          <li key={c.key}>
            <button type="button" className={tab === c.key ? 'active' : ''} aria-pressed={tab === c.key} onClick={() => onPick(c.key)}>
              <Icon name={c.icon} size={18} />
              <span>{c.label}</span>
              <b className={c.key === 'waiting' && Number(counter(c.key)) > 0 ? 'alert' : ''}>{counter(c.key)}</b>
            </button>
          </li>
        ))}
      </ul>
    </dialog>
  );
}
