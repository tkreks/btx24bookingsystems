import { describe, expect, it } from 'vitest';
import { agoText, wizardSteps } from './BookingForm.js';
import { productsTotal, rowTotal } from './ProductsEditor.js';

describe('wizardSteps — шаги мастера по месту открытия', () => {
  it('из меню: клиент → группа → календарь → детали', () => {
    expect(wizardSteps({}, 3)).toEqual(['deal', 'group', 'slot', 'details']);
  });
  it('из сделки: без первого шага; одна группа — без выбора группы', () => {
    expect(wizardSteps({ dealId: 678 }, 3)).toEqual(['group', 'slot', 'details']);
    expect(wizardSteps({ dealId: 678 }, 1)).toEqual(['slot', 'details']);
  });
  it('клик в календаре: ресурс и время известны', () => {
    expect(wizardSteps({ resourceId: 10 }, 3)).toEqual(['deal', 'details']);
  });
});

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

describe('wizardSteps — тип сделки (бани)', () => {
  it('после группы — «Тип сделки»; покупка сертификата — шаг «Сертификат» без даты и товаров', () => {
    expect(wizardSteps({}, 4, { kinds: true, kind: null })).toEqual(['deal', 'group', 'kind', 'slot', 'details']);
    expect(wizardSteps({}, 4, { kinds: true, kind: 'visit' })).toEqual(['deal', 'group', 'kind', 'slot', 'details']);
    expect(wizardSteps({}, 4, { kinds: true, kind: 'certificate' })).toEqual(['deal', 'group', 'kind', 'certificate']);
    expect(wizardSteps({ dealId: 5, resourceId: 3 }, 4, { kinds: true, kind: 'no_payment' })).toEqual(['kind', 'details']);
    expect(wizardSteps({}, 4, { kinds: false, kind: 'certificate' })).toEqual(['deal', 'group', 'slot', 'details']);
  });
});
