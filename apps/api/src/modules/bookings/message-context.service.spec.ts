import { displayValue, mapFields } from './message-context.service.js';

describe('message context: field values for clients', () => {
  it('lists as text, money and numbers in Russian, dates in portal time zone', () => {
    expect(displayValue({ type: 'enumeration', items: [{ ID: 96, VALUE: 'Дом на воде 2' }] }, '96', 'Europe/Moscow')).toBe('Дом на воде 2');
    expect(displayValue({ type: 'money' }, '45000|RUB', 'Europe/Moscow')).toBe('45 000');
    expect(displayValue({ type: 'double' }, '45000.00', 'Europe/Moscow')).toBe('45 000');
    expect(displayValue({ type: 'datetime' }, '2026-10-24T14:00:00+03:00', 'Europe/Moscow')).toBe('24.10.2026 14:00');
    expect(displayValue({ type: 'date' }, '2026-10-24T00:00:00+03:00', 'Europe/Moscow')).toBe('24.10.2026');
    expect(displayValue({ type: 'crm_multifield' }, [{ VALUE: '+7 900' }, { VALUE: '+7 901' }], 'Europe/Moscow')).toBe('+7 900, +7 901');
    expect(displayValue({ type: 'string' }, '', 'Europe/Moscow')).toBe('');
  });

  it('maps by every label and by code', () => {
    const r = mapFields(
      { OPPORTUNITY: '45000.00', UF_CRM_1: '96' },
      { OPPORTUNITY: { type: 'double', title: 'Сумма' }, UF_CRM_1: { type: 'enumeration', title: 'UF_CRM_1', formLabel: 'Банный дом', listLabel: 'Банный дом', items: [{ ID: '96', VALUE: 'Дом на воде 2' }] } },
      'Europe/Moscow',
    );
    expect(r.byTitle).toMatchObject({ сумма: '45 000', 'банный дом': 'Дом на воде 2' });
    expect(r.byCode).toEqual({ OPPORTUNITY: '45 000', UF_CRM_1: 'Дом на воде 2' });
  });
});
