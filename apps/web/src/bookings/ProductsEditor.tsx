import { useEffect, useState } from 'react';
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

/**
 * Товары брони (макет `docs/prototype/ui/booking-wizard.html`): поиск товара группы с подсказками,
 * «Выбрать» — окно со всем каталогом группы, теги разделов (⚙ → группа → разделы с 👁) — окно с
 * товарами раздела; таблица — количество −/+, цена, скидка % / ₽, сумма строки; итоги.
 * Строки сделки заменяются целиком, поэтому у существующей сделки показываются её текущие товары.
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
  // Окно выбора: весь каталог (null) или раздел-тег.
  const [picker, setPicker] = useState<{ section: NonNullable<BookingCatalogDto['sections']>[number] | null } | null>(null);
  const add = (p: BookingCatalogDto['products'][number]) => {
    // Тот же товар ещё раз — +1 к количеству, а не новая строка.
    const at = rows.findIndex((r) => r.productId === p.id);
    if (at >= 0) onChange(rows.map((r, k) => (k === at ? { ...r, quantity: round(r.quantity + 1) } : r)));
    else onChange([...rows, { productId: p.id, name: p.name, price: p.price ?? 0, quantity: 1, discountType: 'percent', discount: 0 }]);
  };
  const locked = !catalog || loading || !!error;
  const words = q.trim().toLocaleLowerCase('ru').split(/\s+/).filter(Boolean);
  const matches = words.length
    ? (catalog?.products ?? []).filter((p) => words.every((w) => `${p.name} ${p.section ?? ''}`.toLocaleLowerCase('ru').includes(w))).slice(0, 8)
    : [];
  const patch = (i: number, p: Partial<ProductRow>) => onChange(rows.map((r, k) => (k === i ? { ...r, ...p } : r)));
  const num = (v: string) => {
    const n = Number(v.replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  const gross = round(rows.reduce((s, r) => s + r.price * r.quantity, 0));
  const total = productsTotal(rows);

  return (
    <div className="pe">
      <div className="pe-tools">
        <button type="button" className="primary pe-pick" disabled={locked} onClick={() => setPicker({ section: null })}>
          Выбрать
        </button>
        {(catalog?.sections ?? []).length > 0 && (
          <span className="pe-tags" role="group" aria-label="Разделы каталога">
            {(catalog?.sections ?? []).map((s) => (
              <button key={s.id} type="button" className="pe-tag" disabled={locked} onClick={() => setPicker({ section: s })}>
                {s.name}
              </button>
            ))}
          </span>
        )}
      </div>
      <div className="pe-add">
        <input
          type="search"
          aria-label="Добавить товар"
          placeholder={catalog ? `Найти и добавить товар${catalog.restricted ? ' группы' : ''}…` : 'Загрузка товаров…'}
          disabled={!catalog || loading || !!error}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {matches.length > 0 && (
          <ul className="cp-hits pe-hits" role="listbox" aria-label="Товары каталога">
            {matches.map((p) => (
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
                  <span className="pe-hit-price">{p.price !== null ? fmtMoney(p.price, p.currency) : 'без цены'}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {words.length > 0 && catalog && !matches.length && <p className="cp-hint">Товар не найден в разделах группы</p>}
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
      {!loading && !error && !rows.length && <p className="cp-hint">Товаров пока нет — «Выбрать», тег раздела или поиск.</p>}
      {picker && catalog && (
        <ProductPicker
          catalog={catalog}
          section={picker.section}
          rows={rows}
          onAdd={add}
          onQuantity={(id, quantity) => onChange(withProductQuantity(rows, id, quantity))}
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
            return (
              <div key={`${r.productId}:${i}`} className="pe-row" role="row">
                <span className="pe-name" role="cell">
                  {r.name}
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
                <span className="pe-price" role="cell">
                  <input inputMode="decimal" aria-label={`Цена: ${r.name}`} value={r.price} onChange={(e) => patch(i, { price: num(e.target.value) })} />
                </span>
                <span className="pe-disc" role="cell">
                  <span className="wz-seg" role="group" aria-label={`Скидка: ${r.name}`}>
                    {(['percent', 'sum'] as const).map((t) => (
                      <button key={t} type="button" aria-pressed={r.discountType === t} className={r.discountType === t ? 'active' : ''} onClick={() => patch(i, { discountType: t, discount: 0 })}>
                        {t === 'percent' ? '%' : '₽'}
                      </button>
                    ))}
                  </span>
                  <input
                    inputMode="decimal"
                    aria-label={`Скидка ${r.discountType === 'percent' ? 'в процентах' : 'в рублях на единицу'}: ${r.name}`}
                    value={r.discount || ''}
                    placeholder="0"
                    onChange={(e) => patch(i, { discount: r.discountType === 'percent' ? Math.min(100, num(e.target.value)) : num(e.target.value) })}
                  />
                </span>
                <span className="pe-sum" role="cell">
                  {line !== full && <s>{rub(full)}</s>}
                  <b>{rub(line)}</b>
                </span>
                <button type="button" className="pe-del" aria-label={`Убрать: ${r.name}`} onClick={() => onChange(rows.filter((_, k) => k !== i))}>
                  ×
                </button>
              </div>
            );
          })}
          <div className="pe-totals">
            {gross !== total && (
              <>
                <span>Без скидки</span>
                <span>{rub(gross)}</span>
                <span>Скидка</span>
                <span className="pe-minus">−{rub(round(gross - total))}</span>
              </>
            )}
            <span className="pe-total-label">Итого</span>
            <b className="pe-total">{rub(total)}</b>
          </div>
        </div>
      )}
    </div>
  );
}

/** Окно выбора товаров: весь каталог группы или раздел (с вложенными), поиск, «+» — в бронь. */
function ProductPicker({
  catalog,
  section,
  rows,
  onAdd,
  onQuantity,
  onClose,
}: {
  catalog: BookingCatalogDto;
  section: NonNullable<BookingCatalogDto['sections']>[number] | null;
  rows: ProductRow[];
  onAdd: (p: BookingCatalogDto['products'][number]) => void;
  onQuantity: (productId: number, quantity: number) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  useEffect(() => {
    // Своё «Escape» — только это окно, не мастер под ним.
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', esc, true);
    return () => window.removeEventListener('keydown', esc, true);
  }, [onClose]);
  const inSection = section ? new Set(section.sectionIds) : null;
  const words = q.trim().toLocaleLowerCase('ru').split(/\s+/).filter(Boolean);
  const list = catalog.products
    .filter((p) => !inSection || (p.sectionId && inSection.has(p.sectionId)))
    .filter((p) => words.every((w) => `${p.name} ${p.section ?? ''}`.toLocaleLowerCase('ru').includes(w)));
  const count = (id: number) => rows.filter((r) => r.productId === id).reduce((n, r) => n + r.quantity, 0);
  return (
    <div className="wz-modal-backdrop" role="presentation" onClick={onClose}>
      <div className="wz-modal pe-picker" role="dialog" aria-modal="true" aria-label={section ? `Раздел «${section.name}»` : 'Товары группы'} onClick={(e) => e.stopPropagation()}>
        <header className="pe-picker-head">
          <h4>{section ? section.name : 'Товары группы'}</h4>
          <button type="button" className="bk-close" aria-label="Закрыть" onClick={onClose}>
            ×
          </button>
        </header>
        <input type="search" autoFocus aria-label="Поиск товара" placeholder="Поиск…" value={q} onChange={(e) => setQ(e.target.value)} />
        <ul className="pe-picker-list">
          {list.map((p) => (
            <li key={p.id}>
              <span className="pe-hit-name">
                <b>{p.name}</b>
                {!section && p.section && <span className="muted">{p.section}</span>}
              </span>
              <span className="pe-hit-price">{p.price !== null ? fmtMoney(p.price, p.currency) : 'без цены'}</span>
              {count(p.id) > 0 ? <PickerQuantity name={p.name} quantity={count(p.id)} onChange={(quantity) => onQuantity(p.id, quantity)} /> : <button type="button" className="pe-picker-add" aria-label={`Добавить: ${p.name}`} onClick={() => onAdd(p)}>Добавить +</button>}
            </li>
          ))}
          {!list.length && <li className="cp-hint">Товаров не найдено.</li>}
        </ul>
        <div className="form-actions">
          <button type="button" className="primary" onClick={onClose}>
            Готово
          </button>
        </div>
      </div>
    </div>
  );
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
