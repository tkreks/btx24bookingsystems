import { describe, expect, it } from 'vitest';
import { fitCategories } from './StatusTabs.js';

describe('вкладки чатов: сколько категорий помещается', () => {
  const widths = [120, 140, 120];
  it('всё помещается — без кнопки ⇅', () => {
    expect(fitCategories(widths, 50, 420, 7)).toBe(3);
  });
  it('не хватает одной — она уходит в ⇅ вместе с остальными', () => {
    expect(fitCategories(widths, 50, 360, 7)).toBe(2);
    expect(fitCategories(widths, 50, 200, 7)).toBe(1);
  });
  it('совсем мало места — все категории за одной кнопкой', () => {
    expect(fitCategories(widths, 50, 100, 7)).toBe(0);
  });
});
