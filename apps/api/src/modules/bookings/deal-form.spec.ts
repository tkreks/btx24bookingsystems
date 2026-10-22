import type { DealFieldConfig } from '@btx24/shared';
import { dealFormFields, dealUpdateFields, toFormValue } from './deal-form.js';

const cfg = (name: string, over: Partial<DealFieldConfig> = {}): DealFieldConfig => ({
  name, required: false, inlineNext: false, showCreate: true, showView: true, showList: false, ...over,
});
const meta = {
  OPPORTUNITY: { type: 'double', title: 'Сумма' },
  UF_PAID: { type: 'money', formLabel: 'Внесено' },
  UF_KIND: { type: 'enumeration', formLabel: 'Тип сделки', items: [{ ID: 72, VALUE: 'Посещение' }, { ID: 74, VALUE: 'Сертификат' }] },
  UF_START: { type: 'datetime', formLabel: 'Начало брони' },
  UF_FILES: { type: 'file', formLabel: 'Файлы' },
  UF_MULTI: { type: 'string', isMultiple: true, formLabel: 'Теги' },
  COMMENTS: { type: 'string', title: 'Комментарий' },
};
const deal = { OPPORTUNITY: '45000.00', UF_PAID: '1500|RUB', UF_KIND: '74', UF_START: '2026-10-25T14:00:00+03:00', UF_MULTI: ['a', 'b'], COMMENTS: 'Тихо' };

describe('dealFormFields', () => {
  const fields = dealFormFields(
    [cfg('OPPORTUNITY', { inlineNext: true }), cfg('UF_PAID'), cfg('UF_KIND', { required: true }), cfg('UF_START'), cfg('UF_FILES'), cfg('UF_MULTI'), cfg('COMMENTS'), cfg('UF_HIDDEN', { showCreate: false, showView: false })],
    meta,
    { bookingStart: 'UF_START' },
    deal,
    'Europe/Moscow',
  );
  const by = Object.fromEntries(fields.map((f) => [f.code, f]));

  it('значения сделки — в виде поля ввода', () => {
    expect(by.OPPORTUNITY).toMatchObject({ kind: 'number', value: '45000', label: 'Сумма', inlineNext: true, readOnly: false });
    expect(by.UF_PAID).toMatchObject({ kind: 'money', value: '1500' });
    expect(by.UF_KIND).toMatchObject({ kind: 'enum', value: '74', required: true, items: [{ id: '72', value: 'Посещение' }, { id: '74', value: 'Сертификат' }] });
    expect(by.COMMENTS.value).toBe('Тихо');
  });
  it('системные, составные и множественные — только чтение, с показом значения', () => {
    expect(by.UF_START).toMatchObject({ role: 'bookingStart', readOnly: true, value: '2026-10-25T14:00' });
    expect(by.UF_FILES.readOnly).toBe(true);
    expect(by.UF_MULTI).toMatchObject({ readOnly: true, display: 'a, b' });
  });
  it('поля, которые нигде не показываются, не попадают в форму', () => {
    expect(by.UF_HIDDEN).toBeUndefined();
  });

  it('dealUpdateFields: перевод в формат Битрикс24 и проверки', () => {
    expect(dealUpdateFields(fields, { OPPORTUNITY: '45 000,5', UF_PAID: '2000', UF_KIND: '72', COMMENTS: '' }, 'RUB', 'Europe/Moscow', false)).toEqual({
      OPPORTUNITY: 45000.5,
      UF_PAID: '2000|RUB',
      UF_KIND: '72',
      COMMENTS: '',
    });
    expect(() => dealUpdateFields(fields, { UF_KIND: '' }, 'RUB', 'Europe/Moscow', false)).toThrow('Заполните поле «Тип сделки»');
    expect(() => dealUpdateFields(fields, { UF_KIND: '99' }, 'RUB', 'Europe/Moscow', false)).toThrow('нет такого варианта');
    expect(() => dealUpdateFields(fields, { UF_START: '2026-10-25T15:00' }, 'RUB', 'Europe/Moscow', false)).toThrow('нельзя менять');
    expect(() => dealUpdateFields(fields, { OPPORTUNITY: 'много' }, 'RUB', 'Europe/Moscow', false)).toThrow('нужно число');
  });
  it('dealUpdateFields при создании: обязательные поля «С» должны прийти', () => {
    expect(() => dealUpdateFields(fields, {}, 'RUB', 'Europe/Moscow', true)).toThrow('Заполните поле «Тип сделки»');
  });
});

describe('toFormValue', () => {
  it('да/нет, дата, пустое', () => {
    expect(toFormValue('1', 'boolean', 'UTC')).toBe('Y');
    expect(toFormValue('N', 'boolean', 'UTC')).toBe('N');
    expect(toFormValue('2026-10-25T00:00:00+03:00', 'date', 'UTC')).toBe('2026-10-25');
    expect(toFormValue(null, 'number', 'UTC')).toBe('');
    expect(toFormValue('|RUB', 'money', 'UTC')).toBe('');
  });
});
