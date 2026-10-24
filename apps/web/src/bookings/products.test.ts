import { describe, expect, it } from 'vitest';
import { productsTotal, withProductQuantity, type ProductRow } from './ProductsEditor.js';

const rows: ProductRow[] = [
  { productId: 1, name: 'Парение', price: 1000, quantity: 2, discountType: 'percent', discount: 10 },
  { productId: 2, name: 'Веник', price: 500, quantity: 1, discountType: 'sum', discount: 50 },
  { productId: 1, name: 'Парение', price: 1200, quantity: 3, discountType: 'sum', discount: 200 },
];

describe('catalog quantities for existing deal rows', () => {
  it('increases quantity without resetting prices or discounts', () => {
    const result = withProductQuantity(rows, 1, 6);
    expect(result).toEqual([{ ...rows[0], quantity: 3 }, rows[1], rows[2]]);
    expect(productsTotal(result)).toBe(6150);
    expect(rows[0].quantity).toBe(2);
  });
  it('reduces duplicate rows from the end, keeping the other product', () => {
    expect(withProductQuantity(rows, 1, 1.5)).toEqual([{ ...rows[0], quantity: 1.5 }, rows[1]]);
  });
  it('zero removes the product completely so it can be added again', () => {
    expect(withProductQuantity(rows, 1, 0)).toEqual([rows[1]]);
  });
  it('rejects invalid quantities and unknown products', () => {
    for (const quantity of [NaN, Infinity, -1]) expect(withProductQuantity(rows, 1, quantity)).toBe(rows);
    expect(withProductQuantity(rows, 99, 1)).toBe(rows);
  });
});
