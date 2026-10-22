import { useState } from 'react';
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

/**
 * Товары брони (макет `docs/prototype/ui/booking-wizard.html`): поиск товара группы с подсказками,
 * таблица — количество −/+, цена, скидка % / ₽, сумма строки; итоги «без скидки / скидка / итого».
 * Строки сделки заменяются целиком, поэтому у существующей сделки показываются её текущие товары.
 */
export function ProductsEditor({
  catalog,
  rows,
  onChange,
  loading = false,
}: {
  catalog: BookingCatalogDto | null;
  rows: ProductRow[];
  onChange: (rows: ProductRow[]) => void;
  loading?: boolean;
}) {
  const [q, setQ] = useState('');
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
      <div className="pe-add">
        <input
          type="search"
          aria-label="Добавить товар"
          placeholder={catalog ? `Найти и добавить товар${catalog.restricted ? ' группы' : ''}…` : 'Загрузка товаров…'}
          disabled={!catalog}
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
                    onChange([...rows, { productId: p.id, name: p.name, price: p.price ?? 0, quantity: 1, discountType: 'percent', discount: 0 }]);
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
      {!loading && !rows.length && <p className="cp-hint">Товаров пока нет — найдите товар выше.</p>}
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
