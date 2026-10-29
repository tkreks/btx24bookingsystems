import { describe, expect, it } from 'vitest';
import { formatDuration, freeSpans, mergeSpans, paymentState } from './viewer.js';

describe('внешний просмотр: статус оплаты', () => {
  it('неизвестное не превращается в ноль', () => {
    expect(paymentState(null, 5000)).toEqual({ status: 'unknown', percent: null, debt: null, overpay: null });
    expect(paymentState(15000, null).status).toBe('unknown');
  });
  it('частично, полностью, переплата, не оплачено', () => {
    expect(paymentState(15000, 5000)).toEqual({ status: 'partial', percent: 33, debt: 10000, overpay: null });
    expect(paymentState(15000, 15000)).toMatchObject({ status: 'paid', percent: 100, debt: 0 });
    expect(paymentState(15000, 16000)).toMatchObject({ status: 'overpaid', overpay: 1000, debt: 0 });
    expect(paymentState(15000, 0)).toMatchObject({ status: 'unpaid', percent: 0, debt: 15000 });
  });
});

describe('внешний просмотр: время', () => {
  it('продолжительность по-русски', () => {
    expect(formatDuration(180)).toBe('3 часа');
    expect(formatDuration(210)).toBe('3 часа 30 минут');
    expect(formatDuration(45)).toBe('45 минут');
    expect(formatDuration(60 * 25)).toBe('1 сутки 1 час');
    expect(formatDuration(0)).toBe('0 минут');
  });
  it('свободные окна между бронями, пересечения сливаются', () => {
    const busy = [
      { start: 13, end: 16 },
      { start: 15, end: 17 },
      { start: 20, end: 30 },
    ];
    expect(mergeSpans(busy, 10, 22)).toEqual([
      { start: 13, end: 17 },
      { start: 20, end: 22 },
    ]);
    expect(freeSpans(busy, 10, 22)).toEqual([
      { start: 10, end: 13 },
      { start: 17, end: 20 },
    ]);
    expect(freeSpans([], 0, 24)).toEqual([{ start: 0, end: 24 }]);
  });
});
