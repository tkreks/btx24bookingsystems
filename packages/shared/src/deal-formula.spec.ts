import { describe, expect, it } from 'vitest';
import { checkFormula, evalFormula, formNumber, formulaRefs } from './deal-formula.js';

describe('deal formulas', () => {
  it('50% от суммы заказа', () => {
    expect(evalFormula('{OPPORTUNITY} * 50%', { OPPORTUNITY: '45 000' })).toBe(22500);
    expect(evalFormula('={opportunity}*20%', { OPPORTUNITY: '1234,5' })).toBe(246.9);
    expect(evalFormula('{OPPORTUNITY} × 50%', { OPPORTUNITY: '100' })).toBe(50);
  });
  it('приоритеты, скобки, минус', () => {
    expect(evalFormula('({A} - {B}) * 2 + 1', { A: '10', B: '4' })).toBe(13);
    expect(evalFormula('-{A} + 5', { A: '2' })).toBe(3);
    expect(evalFormula('({A} + {B})%', { A: '50', B: '50' })).toBe(1);
  });
  it('нет значения или деление на ноль — null', () => {
    expect(evalFormula('{A} * 50%', {})).toBeNull();
    expect(evalFormula('{A} / {B}', { A: '1', B: '0' })).toBeNull();
    expect(evalFormula('{A} *', { A: '1' })).toBeNull();
  });
  it('проверка в настройках', () => {
    expect(checkFormula('{OPPORTUNITY} * 50%', ['OPPORTUNITY'])).toBeNull();
    expect(checkFormula('{X} * 2', ['OPPORTUNITY'])).toBe('Поля {X} нет среди полей группы');
    expect(checkFormula('{A} * (2', ['A'])).toBe('Не хватает «)»');
    expect(checkFormula('2 $ 3')).toBe('Непонятный символ «$»');
    expect(checkFormula('')).toBe('Пустая формула');
  });
  it('ссылки и числа формы', () => {
    expect(formulaRefs('{a} + {B} * {a}')).toEqual(['A', 'B']);
    expect(formNumber(' 1 500,25 ')).toBe(1500.25);
    expect(formNumber('')).toBeNull();
  });
});
