import { describe, expect, it } from 'vitest';
import type { DealFormField } from '@btx24/shared';
import { fieldRows } from './DealFieldsEditor.js';

const f = (code: string, inlineNext = false) => ({ code, inlineNext }) as DealFormField;

describe('fieldRows — «2 в линии» как в настройках группы', () => {
  it('поле с флагом и следующее — одна строка; порядок сохраняется', () => {
    const rows = fieldRows([f('OPPORTUNITY', true), f('PAID'), f('SUR', true), f('PRE'), f('KIND')]);
    expect(rows.map((r) => r.map((x) => x.code))).toEqual([['OPPORTUNITY', 'PAID'], ['SUR', 'PRE'], ['KIND']]);
  });
  it('флаг у последнего поля и подряд идущие флаги не склеивают три поля', () => {
    expect(fieldRows([f('A', true), f('B', true), f('C', true)]).map((r) => r.length)).toEqual([2, 1]);
  });
});
