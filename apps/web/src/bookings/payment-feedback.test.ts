import { describe, expect, it } from 'vitest';
import { paymentFeedback } from './payment-feedback.js';

describe('call payment feedback', () => {
  it('waits for the link without claiming delivery', () => {
    expect(paymentFeedback({ status: 'link_pending', messageSent: false, error: null })).toBe('Счёт создан. Ждём формирования ссылки.');
  });
  it('only claims sent when messageSent proves delivery', () => {
    expect(paymentFeedback({ status: 'sent', messageSent: true, error: null })).toMatch(/Ссылка отправлена/);
    expect(paymentFeedback({ status: 'sent', messageSent: false, error: null })).toMatch(/не отправлена/);
  });
  it('surfaces an error instead of success', () => {
    expect(paymentFeedback({ status: 'sent', messageSent: false, error: 'Нет чата' })).toBe('Нет чата');
  });
});
