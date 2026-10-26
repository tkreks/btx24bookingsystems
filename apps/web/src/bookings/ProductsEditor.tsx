import { useEffect, useRef, useState } from 'react';
import { discountedPrice, type BookingCatalogDto, type ProductDiscountType } from '@btx24/shared';
import { fmtMoney } from '../format.js';

export interface ProductRow {
  productId: number;
  name: string;
  /** Цена за единицу без скидки. */
  price: number;
  quantity: number;
  discountType: ProductDiscountType;
  /** Процент или сумма на единицу — по `discountType`. */
  discount: number;
  /** Подставлен по умолчанию для ресурса (метка «по умолчанию · Баня 1»). */
  defaultFor?: string;
}

const round = (n: number) => Math.round(n * 100) / 100;
/** Сумма строки со скидкой. */
export const rowTotal = (r: ProductRow) => round(discountedPrice(r) * r.quantity);
/** Итог товаров (со скидками). */
export const productsTotal = (rows: ProductRow[]) => round(rows.reduce((s, r) => s + rowTotal(r), 0));
const rub = (n: number) => fmtMoney(n, 'RUB');

/** Изменение общего количества сохраняет цены/скидки существующих строк одного товара. */
export function withProductQuantity(rows: ProductRow[], productId: number, quantity: number): ProductRow[] {
  if (!Number.isFinite(quantity) || quantity < 0) return rows;
  const next = round(quantity);
  const indices = rows.flatMap((r, i) => r.productId === productId ? [i] : []);
  if (!indices.length) return rows;
  if (next === 0) return rows.filter((r) => r.productId !== productId);
  const current = round(indices.reduce((n, i) => n + rows[i].quantity, 0));
  if (next >= current) return rows.map((r, i) => i === indices[0] ? { ...r, quantity: round(r.quantity + next - current) } : r);
  let remove = round(current - next);
  const result = [...rows];
  for (const i of [...indices].reverse()) {
    const take = Math.min(result[i].quantity, remove);
    result[i] = { ...result[i], quantity: round(result[i].quantity - take) };
    remove = round(remove - take);
  }
  return result.filter((r) => r.productId !== productId || r.quantity > 0);
}

/** Скидка в процентах на все строки (ручная скидка суммой тоже заменяется процентом). */
export function withDiscountAll(rows: ProductRow[], percent: number): ProductRow[] {
  const p = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0));
  return rows.map((r) => ({ ...r, discountType: 'percent', discount: p }));
}

/** Сколько выбрано товаров раздела (позиций — строк с товаром из раздела). */
export function sectionCount(rows: ProductRow[], catalog: BookingCatalogDto, sectionIds: string[]): number {
  const ids = new Set(sectionIds);
  const inSection = new Set(catalog.products.filter((p) => p.sectionId && ids.has(p.sectionId)).map((p) => p.id));
  return new Set(rows.filter((r) => inSection.has(r.productId)).map((r) => r.productId)).size;
}

type Product = BookingCatalogDto['products'][number];
type Section = NonNullable<BookingCatalogDto['sections']>[number];
/** Тегов разделов в панели сразу; остальные — под «Ещё ▾». */
const TAGS_SHOWN = 4;
const matchWords = (q: string) => q.trim().toLocaleLowerCase('ru').split(/\s+/).filter(Boolean);
const matches = (p: Product, words: string[]) => words.every((w) => `${p.name} ${p.section ?? ''}`.toLocaleLowerCase('ru').includes(w));

/**
 * Товары брони (макет `docs/prototype/ui/booking-constructor.html`, состояния C, D): панель «Допы» —
 * поиск с выпадающим списком, теги разделов (⚙ → группа → разделы с 👁; первые 4, остальные под
 * «Ещё ▾») со счётчиком выбранного и «Весь каталог»; таблица — количество −/+, цена (изменённая — «изм.»
 * и ↺ к цене каталога), скидка % / ₽, сумма строки; «Скидка на всё…»; итоги. Строки сделки
 * заменяются целиком, поэтому у существующей сделки показываются её текущие товары.
 */
export function ProductsEditor({
  catalog,
  rows,
  onChange,
  loading = false,
  error,
  onRetry,
}: {
  catalog: BookingCatalogDto | null;
  rows: ProductRow[];
  onChange: (rows: ProductRow[]) => void;
  loading?: boolean;
  /** Товары сделки не загрузились: править нельзя (сохранение заменило бы их целиком). */
  error?: string;
  onRetry?: () => void;
}) {
  const [q, setQ] = useState('');
  // Окно каталога: раздел (null — «Все»).
  const [picker, setPicker] = useState<{ section: string | null } | null>(null);
  const [more, setMore] = useState(false);
  const [discountAll, setDiscountAll] = useState<string | null>(null);
  // Только что добавленные строки — подсветка (до следующей правки).
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  const change = (next: ProductRow[], added: number[] = []) => {
    setFresh(new Set(added));
    onChange(next);
  };
  const add = (p: Product) => {
    // Тот же товар ещё раз — +1 к количеству, а не новая строка.
    const at = rows.findIndex((r) => r.productId === p.id);
    if (at >= 0) change(rows.map((r, k) => (k === at ? { ...r, quantity: round(r.quantity + 1) } : r)), [p.id]);
    else change([...rows, { productId: p.id, name: p.name, price: p.price ?? 0, quantity: 1, discountType: 'percent', discount: 0 }], [p.id]);
  };
  const locked = !catalog || loading || !!error;
  const words = matchWords(q);
  const hits = words.length ? (catalog?.products ?? []).filter((p) => matches(p, words)).slice(0, 6) : [];
  const patch = (i: number, p: Partial<ProductRow>) => change(rows.map((r, k) => (k === i ? { ...r, ...p } : r)));
  const num = (v: string) => {
    const n = Number(v.replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  const gross = round(rows.reduce((s, r) => s + r.price * r.quantity, 0));
  const total = productsTotal(rows);
  const byId = new Map((catalog?.products ?? []).map((p) => [p.id, p]));
  const sections = catalog?.sections ?? [];
  const tags = more ? sections : sections.slice(0, TAGS_SHOWN);
  const lockedHint = loading ? 'Загрузка товаров сделки…' : error ? 'Товары сделки не загрузились' : !catalog ? 'Загрузка каталога…' : undefined;

  return (
    <div className="pe">
      <div className="pe-panel">
        <div className="pe-panel-row">
          <div className="pe-add">
            <input
              type="search"
              aria-label="Найти товар или услугу"
              placeholder={catalog ? `Найти товар или услугу${catalog.restricted ? ' группы' : ''}…` : 'Загрузка товаров…'}
              disabled={locked}
              title={lockedHint}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  // Enter в поиске добавляет первое совпадение, а не отправляет форму.
                  e.preventDefault();
                  if (hits[0]) {
                    add(hits[0]);
                    setQ('');
                  }
                }
              }}
            />
            {hits.length > 0 && (
              <ul className="cp-hits pe-hits" role="listbox" aria-label="Товары каталога">
                {hits.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={false}
                      onClick={() => {
                        add(p);
                        setQ('');
                      }}
                    >
                      <span className="pe-hit-name">
                        <b>{p.name}</b>
                        {p.section && <span className="muted">{p.section}</span>}
                      </span>
                      <span className={`pe-hit-price${p.price === null ? ' muted' : ''}`}>{p.price !== null ? fmtMoney(p.price, p.currency) : 'без цены'}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {words.length > 0 && catalog && !hits.length && <p className="cp-hint">Товар не найден в разделах группы</p>}
          </div>
          <button type="button" className="pe-pick" disabled={locked} title={lockedHint} onClick={() => setPicker({ section: null })}>
            ▦ Весь каталог
          </button>
        </div>
        {sections.length > 0 && (
          <span className="pe-tags" role="group" aria-label="Разделы каталога">
            {tags.map((s) => {
              const n = catalog ? sectionCount(rows, catalog, s.sectionIds) : 0;
              return (
                <button key={s.id} type="button" className={`pe-tag${n ? ' picked' : ''}`} disabled={locked} title={lockedHint} onClick={() => setPicker({ section: s.id })}>
                  {s.name}
                  {n > 0 && <i className="pe-count">{n}</i>}
                </button>
              );
            })}
            {sections.length > TAGS_SHOWN && (
              <button type="button" className="pe-tag pe-tag-more" aria-expanded={more} onClick={() => setMore(!more)}>
                {more ? 'Свернуть ▴' : `Ещё ${sections.length - TAGS_SHOWN} ▾`}
              </button>
            )}
          </span>
        )}
      </div>
      {loading && <p className="cp-hint">Загрузка товаров сделки…</p>}
      {error && (
        <p className="notice error" role="alert">
          Не удалось загрузить товары сделки: {error}.{' '}
          {onRetry && (
            <button type="button" className="link" onClick={onRetry}>
              Повторить
            </button>
          )}
        </p>
      )}
      {!loading && !error && !rows.length && <p className="cp-hint">Товаров пока нет — поиск, тег раздела или «Весь каталог».</p>}
      {picker && catalog && (
        <CatalogDialog
          catalog={catalog}
          section={picker.section}
          rows={rows}
          onAdd={add}
          onQuantity={(id, quantity) => change(withProductQuantity(rows, id, quantity), [id])}
          onClose={() => setPicker(null)}
        />
      )}
      {rows.length > 0 && (
        <div className="pe-table" role="table" aria-label="Товары">
          <div className="pe-row pe-head" role="row">
            <span role="columnheader">Товар</span>
            <span role="columnheader">Кол-во</span>
            <span role="columnheader">Цена, ₽</span>
            <span role="columnheader">Скидка</span>
            <span role="columnheader" className="pe-r">
              Сумма
            </span>
            <span />
          </div>
          {rows.map((r, i) => {
            const line = rowTotal(r);
            const full = round(r.price * r.quantity);
            const p = byId.get(r.productId);
            const changed = p?.price != null && p.price !== r.price;
            return (
              <div key={`${r.productId}:${i}`} className={`pe-row${fresh.has(r.productId) ? ' fresh' : ''}`} role="row">
                <span className="pe-name" role="cell">
                  <b>{r.name}</b>
                  {r.defaultFor && <i className="pe-default">по умолчанию · {r.defaultFor}</i>}
                  {changed ? (
                    <span className="pe-changed">
                      каталог {rub(p!.price!)}{' '}
                      <button type="button" className="link" title="Вернуть цену каталога" aria-label={`Вернуть цену каталога: ${r.name}`} onClick={() => patch(i, { price: p!.price! })}>
                        ↺
                      </button>
                    </span>
                  ) : (
                    p?.section && <span className="muted">{p.section}</span>
                  )}
                  {p && p.price === null && !r.price && <span className="pe-warn">без цены — укажите цену</span>}
                </span>
                <span className="pe-qty" role="cell">
                  <button type="button" aria-label={`Меньше: ${r.name}`} onClick={() => patch(i, { quantity: Math.max(1, round(r.quantity - 1)) })}>
                    −
                  </button>
                  <input inputMode="decimal" aria-label={`Количество: ${r.name}`} value={r.quantity} onChange={(e) => patch(i, { quantity: num(e.target.value) })} />
                  <button type="button" aria-label={`Больше: ${r.name}`} onClick={() => patch(i, { quantity: round(r.quantity + 1) })}>
                    +
                  </button>
                </span>
                <span className={`pe-price${changed ? ' changed' : ''}`} role="cell">
                  {changed && <i className="pe-mark">изм.</i>}
                  <input inputMode="decimal" aria-label={`Цена: ${r.name}`} value={r.price} onChange={(e) => patch(i, { price: num(e.target.value) })} />
                </span>
                <span className="pe-disc" role="cell">
                  <input
                    inputMode="decimal"
                    aria-label={`Скидка ${r.discountType === 'percent' ? 'в процентах' : 'в рублях на единицу'}: ${r.name}`}
                    value={r.discount || ''}
                    placeholder="0"
                    onChange={(e) => patch(i, { discount: r.discountType === 'percent' ? Math.min(100, num(e.target.value)) : num(e.target.value) })}
                  />
                  <button
                    type="button"
                    className="pe-disc-type"
                    title={r.discountType === 'percent' ? 'Скидка в процентах — переключить на рубли' : 'Скидка в рублях на единицу — переключить на проценты'}
                    aria-label={`Тип скидки: ${r.name}`}
                    onClick={() => patch(i, { discountType: r.discountType === 'percent' ? 'sum' : 'percent', discount: 0 })}
                  >
                    {r.discountType === 'percent' ? '%' : '₽'}
                  </button>
                </span>
                <span className="pe-sum" role="cell">
                  {line !== full && <s>{rub(full)}</s>}
                  <b>{rub(line)}</b>
                </span>
                <button type="button" className="pe-del" aria-label={`Убрать: ${r.name}`} onClick={() => change(rows.filter((_, k) => k !== i))}>
                  ×
                </button>
              </div>
            );
          })}
          <div className="pe-foot">
            {discountAll === null ? (
              <button type="button" className="link" onClick={() => setDiscountAll('')}>
                Скидка на всё…
              </button>
            ) : (
              <span className="pe-disc-all">
                <input
                  autoFocus
                  inputMode="decimal"
                  aria-label="Скидка на все товары, %"
                  placeholder="10"
                  value={discountAll}
                  onChange={(e) => setDiscountAll(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      change(withDiscountAll(rows, num(discountAll)));
                      setDiscountAll(null);
                    }
                    if (e.key === 'Escape') {
                      e.stopPropagation();
                      setDiscountAll(null);
                    }
                  }}
                />
                %
                <button
                  type="button"
                  onClick={() => {
                    change(withDiscountAll(rows, num(discountAll)));
                    setDiscountAll(null);
                  }}
                >
                  Применить ко всем
                </button>
                <button type="button" className="link" onClick={() => setDiscountAll(null)}>
                  Отмена
                </button>
              </span>
            )}
            <div className="pe-totals">
              {gross !== total && (
                <>
                  <span>Без скидки</span>
                  <span>{rub(gross)}</span>
                  <span className="pe-minus">Скидка</span>
                  <span className="pe-minus">−{rub(round(gross - total))}</span>
                </>
              )}
              <span className="pe-total-label">Итого</span>
              <b className="pe-total">{rub(total)}</b>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Окно каталога (нативный `<dialog>`): слева «Все» и разделы с числом товаров и счётчиком выбранного,
 * справа товары раздела (с вложенными); поиск — по всему каталогу, с подписью раздела. Строка: название,
 * цена (`без цены` серым), «+» или степпер (0 — убрать). Цена и скидка здесь не правятся. Esc закрывает
 * только окно.
 */
export function CatalogDialog({
  catalog,
  section,
  rows,
  onAdd,
  onQuantity,
  onClose,
}: {
  catalog: BookingCatalogDto;
  section: string | null;
  rows: ProductRow[];
  onAdd: (p: Product) => void;
  onQuantity: (productId: number, quantity: number) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [q, setQ] = useState('');
  const [current, setCurrent] = useState<string | null>(section);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const sections: Section[] = catalog.sections ?? [];
  const sec = sections.find((s) => s.id === current) ?? null;
  const inSection = sec ? new Set(sec.sectionIds) : null;
  const words = matchWords(q);
  const list = words.length
    ? catalog.products.filter((p) => matches(p, words))
    : catalog.products.filter((p) => !inSection || (p.sectionId && inSection.has(p.sectionId)));
  const count = (id: number) => rows.filter((r) => r.productId === id).reduce((n, r) => n + r.quantity, 0);
  const sizeOf = (s: Section) => {
    const ids = new Set(s.sectionIds);
    return catalog.products.filter((p) => p.sectionId && ids.has(p.sectionId)).length;
  };
  const picked = new Set(rows.map((r) => r.productId)).size;
  return (
    <dialog
      ref={ref}
      className="pe-catalog"
      aria-label="Каталог"
      onCancel={(e) => {
        // Esc — только это окно, не конструктор под ним.
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') e.stopPropagation();
        if (e.key === 'Enter' && e.target instanceof HTMLInputElement) e.preventDefault();
      }}
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === ref.current) onClose();
      }}
    >
      <header className="pe-catalog-head">
        <h4>Каталог</h4>
        <button type="button" className="bk-close" aria-label="Закрыть" onClick={onClose}>
          ×
        </button>
      </header>
      <input className="pe-catalog-search" type="search" autoFocus aria-label="Поиск по всему каталогу" placeholder="Поиск по всему каталогу" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="pe-catalog-body">
        <nav className="pe-catalog-nav" aria-label="Разделы">
          {[null, ...sections].map((s) => {
            const n = s ? sectionCount(rows, catalog, s.sectionIds) : picked;
            const id = s?.id ?? null;
            return (
              <button
                key={id ?? 'all'}
                type="button"
                aria-pressed={current === id && !words.length}
                className={current === id && !words.length ? 'active' : ''}
                onClick={() => {
                  setCurrent(id);
                  setQ('');
                }}
              >
                <span>{s?.name ?? 'Все'}</span>
                <small>{s ? sizeOf(s) : catalog.products.length}</small>
                {n > 0 && <i className="pe-count">{n}</i>}
              </button>
            );
          })}
        </nav>
        <ul className="pe-catalog-list" aria-label={words.length ? 'Найдено' : (sec?.name ?? 'Все товары')}>
          {list.map((p) => {
            const n = count(p.id);
            return (
              <li key={p.id} className={n > 0 ? 'picked' : ''}>
                <span className="pe-hit-name">
                  <b>{p.name}</b>
                  {(words.length || !sec) && p.section && <span className="muted">{p.section}</span>}
                </span>
                <span className={`pe-hit-price${p.price === null ? ' muted' : ''}`}>{p.price !== null ? fmtMoney(p.price, p.currency) : 'без цены'}</span>
                {n > 0 ? (
                  <PickerQuantity name={p.name} quantity={n} onChange={(quantity) => onQuantity(p.id, quantity)} />
                ) : (
                  <button type="button" className="pe-picker-add" aria-label={`Добавить: ${p.name}`} onClick={() => onAdd(p)}>
                    +
                  </button>
                )}
              </li>
            );
          })}
          {!list.length && <li className="cp-hint">Товаров не найдено.</li>}
        </ul>
      </div>
      <footer className="pe-catalog-foot">
        <span>
          Выбрано: <b>{picked} {plural(picked, 'позиция', 'позиции', 'позиций')} · {rub(productsTotal(rows))}</b>
        </span>
        <button type="button" className="primary" onClick={onClose}>
          Готово
        </button>
      </footer>
    </dialog>
  );
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
}

function PickerQuantity({ name, quantity, onChange }: { name: string; quantity: number; onChange: (quantity: number) => void }) {
  const [draft, setDraft] = useState(String(quantity));
  useEffect(() => setDraft(String(quantity)), [quantity]);
  return <span className="pe-picker-quantity" role="group" aria-label={`Количество: ${name}`}>
    <button type="button" aria-label={`Меньше: ${name}`} onClick={() => onChange(Math.max(0, round(quantity - 1)))}>−</button>
    <input aria-label={`Количество: ${name}`} inputMode="decimal" value={draft} onChange={(e) => {
      setDraft(e.target.value);
      if (!e.target.value.trim()) return;
      const value = Number(e.target.value.replace(',', '.'));
      if (Number.isFinite(value) && value >= 0) onChange(round(value));
    }} onBlur={() => setDraft(String(quantity))} />
    <button type="button" aria-label={`Больше: ${name}`} onClick={() => onChange(round(quantity + 1))}>+</button>
  </span>;
}
