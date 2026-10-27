import { describe, expect, it } from 'vitest';
import { centeredScrollLeft, pastShare } from './timeline-data.js';

describe('шкала броней: прошедшее и прокрутка', () => {
  it('доля прошедшего у брони', () => {
    expect(pastShare({ from: 0.2, to: 0.4 }, 0, 100, 10)).toBe(0);
    expect(pastShare({ from: 0.2, to: 0.4 }, 0, 100, 30)).toBeCloseTo(0.5);
    expect(pastShare({ from: 0.2, to: 0.4 }, 0, 100, 50)).toBe(1);
  });

  it('текущее время — по центру видимой части, в пределах шкалы', () => {
    // 13:00 → доля 13/24; шкала 140 + 24×40 = 1100px, видно 500px.
    expect(centeredScrollLeft(1100, 500, 13 / 24)).toBe(Math.round(140 + (13 / 24) * 960 - 250));
    expect(centeredScrollLeft(1100, 500, 0)).toBe(0);
    expect(centeredScrollLeft(1100, 500, 1)).toBe(600);
  });
});
