import { useState } from 'react';
import type { BookingCatalogDto } from '@btx24/shared';
import { fmtMoney } from '../format.js';

export interface ProductRow {
  productId: number;
  name: string;
  price: number;
  quantity: number;
}

/** Сумма строк товаров. */
export const productsTotal = (rows: ProductRow[]) => Math.round(rows.reduce((s, r) => s + r.price * r.quantity, 0) * 100) / 100;

/**
 * Товары брони: товары группы (разделы каталога из настроек группы) — поиск и добавление, количество
 * и цена в строке, итог. Строки сделки заменяются целиком, поэтому у существующей сделки форма
 * показывает её текущие товары.
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

  return (
    <div className="pe">
      {loading && <p className="cp-hint">Загрузка товаров сделки…</p>}
      {rows.length > 0 && (
        <div className="pe-rows" role="table" aria-label="Товары">
          {rows.map((r, i) => (
            <div key={`${r.productId}:${i}`} className="pe-row" role="row">
              <span className="pe-name" role="cell">
                {r.name}
              </span>
              <label className="pe-qty" role="cell">
                <span className="sr-only">Количество</span>
                <input inputMode="decimal" aria-label={`Количество: ${r.name}`} value={r.quantity} onChange={(e) => patch(i, { quantity: num(e.target.value) })} />
              </label>
              <span className="pe-x" aria-hidden="true">
                ×
              </span>
              <label className="pe-price" role="cell">
                <span className="sr-only">Цена</span>
                <input inputMode="decimal" aria-label={`Цена: ${r.name}`} value={r.price} onChange={(e) => patch(i, { price: num(e.target.value) })} />
              </label>
              <span className="pe-sum" role="cell">
                {fmtMoney(Math.round(r.price * r.quantity * 100) / 100, 'RUB')}
              </span>
              <button type="button" className="df-reset" aria-label={`Убрать: ${r.name}`} onClick={() => onChange(rows.filter((_, k) => k !== i))}>
                ×
              </button>
            </div>
          ))}
          <div className="pe-total">
            Итого: <b>{fmtMoney(productsTotal(rows), 'RUB')}</b>
          </div>
        </div>
      )}
      <div className="pe-add">
        <input
          type="search"
          aria-label="Добавить товар"
          placeholder={catalog ? `＋ Добавить товар${catalog.restricted ? ' группы' : ''}: начните вводить название` : 'Загрузка товаров…'}
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
                    onChange([...rows, { productId: p.id, name: p.name, price: p.price ?? 0, quantity: 1 }]);
                    setQ('');
                  }}
                >
                  <b>{p.name}</b>
                  <span className="muted">
                    {p.section ? `${p.section} · ` : ''}
                    {p.price !== null ? fmtMoney(p.price, p.currency) : 'без цены'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {words.length > 0 && catalog && !matches.length && <p className="cp-hint">Товар не найден в разделах группы</p>}
      </div>
    </div>
  );
}
