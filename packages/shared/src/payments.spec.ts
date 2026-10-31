import { describe, expect, it } from 'vitest';
import { invoiceDisplayStatus, moneyValue, paymentAmount } from './payments.js';

describe('invoiceDisplayStatus', () => {
  const req = (status: string, messageSent: boolean) => ({ status, messageSent }) as Parameters<typeof invoiceDisplayStatus>[1];
  it('стадия Битрикс24 важнее заявки', () => {
    expect(invoiceDisplayStatus('paid', req('sent', true))).toBe('paid');
    expect(invoiceDisplayStatus('failed', req('sent', true))).toBe('lost');
  });
  it('открытый счёт заявки: ссылка у клиента — ждёт оплату, иначе выставлен', () => {
    expect(invoiceDisplayStatus('open', req('sent', true))).toBe('waiting');
    expect(invoiceDisplayStatus('open', req('sent', false))).toBe('issued');
    expect(invoiceDisplayStatus('open', req('link_pending', false))).toBe('issued');
    expect(invoiceDisplayStatus('open', req('expired', true))).toBe('lost');
    expect(invoiceDisplayStatus('open', req('cancelled', false))).toBe('lost');
    expect(invoiceDisplayStatus('open', req('paid', true))).toBe('paid');
  });
  it('счёт не приложения: по стадии, открытый — ждёт оплату', () => {
    expect(invoiceDisplayStatus('open', null)).toBe('waiting');
    expect(invoiceDisplayStatus('paid', null)).toBe('paid');
    expect(invoiceDisplayStatus('failed', null)).toBe('lost');
  });
});

describe('paymentAmount', () => {
  it('prepayment: manual from the deal → fixed of the group → percent of the deal', () => {
    expect(paymentAmount('prepayment', { fixed: 25000, manual: 10000, opportunity: 90000, percent: 50 })).toEqual({ amount: 10000, source: 'manual' });
    expect(paymentAmount('prepayment', { fixed: 25000, manual: null, opportunity: 90000, percent: 50 })).toEqual({ amount: 25000, source: 'fixed' });
    expect(paymentAmount('prepayment', { manual: null, opportunity: 90001, percent: 50 })).toEqual({ amount: 45000.5, source: 'percent' });
    expect(paymentAmount('prepayment', { opportunity: 40000 })).toEqual({ amount: 40000, source: 'percent' });
    expect(paymentAmount('prepayment', {})).toEqual({ amount: null, source: 'none' });
  });

  it('surcharge: only the manual surcharge of the deal', () => {
    expect(paymentAmount('surcharge', { fixed: 25000, manual: 7000, opportunity: 90000 })).toEqual({ amount: 7000, source: 'manual' });
    expect(paymentAmount('surcharge', { fixed: 25000, opportunity: 90000 })).toEqual({ amount: null, source: 'none' });
  });

  it('reads money fields', () => {
    expect(moneyValue('25000|RUB')).toBe(25000);
    expect(moneyValue('')).toBeNull();
    expect(moneyValue(null)).toBeNull();
  });
});

describe('suggestInvoiceConfig', () => {
  it('finds payment stages and the link field by names', async () => {
    const { suggestInvoiceConfig } = await import('./payments.js');
    const meta = {
      categories: [{ id: 2, name: 'Общая', stages: [{ id: 'DT31_2:UC_X', name: 'Новый счёт' }, { id: 'DT31_2:N', name: 'Внесение предоплаты' }, { id: 'DT31_2:S', name: 'Внесение доплаты' }] }],
      fields: [
        { code: 'ufCrmSmartInvoiceLink', title: 'Ссылка на оплату +1', type: 'url', items: [] },
        { code: 'ufCrm_SMART_INVOICE_1754852279063', title: 'Ссылка на оплату счёта', type: 'string', items: [] },
      ],
    };
    expect(suggestInvoiceConfig(meta)).toEqual({ categoryId: 2, prepaymentStageId: 'DT31_2:N', surchargeStageId: 'DT31_2:S', linkField: 'ufCrm_SMART_INVOICE_1754852279063', fields: {} });
  });
});
