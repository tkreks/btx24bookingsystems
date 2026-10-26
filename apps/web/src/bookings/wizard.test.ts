import { describe, expect, it } from 'vitest';
import { agoText, dayShort, errorSection, nightsText } from './BookingForm.js';
import { productsTotal, rowTotal } from './ProductsEditor.js';

describe('agoText', () => {
  const now = Date.parse('2026-10-22T12:00:00Z');
  it('минуты, часы, вчера, дни', () => {
    expect(agoText('2026-10-22T11:48:00Z', now)).toBe('12 мин назад');
    expect(agoText('2026-10-22T09:00:00Z', now)).toBe('3 ч назад');
    expect(agoText('2026-10-21T10:00:00Z', now)).toBe('вчера');
    expect(agoText('2026-10-17T12:00:00Z', now)).toBe('5 дн назад');
    expect(agoText(null, now)).toBe('');
  });
});

describe('товары со скидками', () => {
  it('процент и сумма на единицу; итог', () => {
    const a = { productId: 1, name: 'Баня, час', price: 3500, quantity: 4, discountType: 'percent' as const, discount: 10 };
    const b = { productId: 2, name: 'Веник', price: 450, quantity: 2, discountType: 'sum' as const, discount: 50 };
    expect(rowTotal(a)).toBe(12600);
    expect(rowTotal(b)).toBe(800);
    expect(productsTotal([a, b])).toBe(13400);
  });
});

describe('newDealTitle', () => {
  it('имя клиента + дата брони + ресурс', async () => {
    const { newDealTitle } = await import('./BookingForm.js');
    expect(newDealTitle('Иван Петров', '2026-10-25', ['Баня 1'])).toBe('Иван Петров 25.10.2026 Баня 1');
    expect(newDealTitle(null, '2026-10-25', ['Баня 1', 'Баня 2'])).toBe('Новая сделка 25.10.2026 Баня 1, Баня 2');
  });
});

describe('сводки и ошибки конструктора', () => {
  it('день брони, ночи', () => {
    expect(dayShort('2026-10-27')).toBe('вт 27.10');
    expect([1, 2, 5, 11, 21].map(nightsText)).toEqual(['1 ночь', '2 ночи', '5 ночей', '11 ночей', '21 ночь']);
  });
  it('ошибка создания — раздел для исправления', () => {
    expect(errorSection('Баня 1 занята в это время')).toBe('slot');
    expect(errorSection('Выберите тип бронирования')).toBe('goods');
    expect(errorSection('Заполните поле «Гостей»')).toBe('fields');
    expect(errorSection('Битрикс24 недоступен')).toBeNull();
  });
});
