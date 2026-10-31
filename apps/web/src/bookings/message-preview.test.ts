import { describe, expect, it } from 'vitest';
import { deadlinePreview, messagePreviewParts } from './message-preview.js';

describe('messagePreviewParts', () => {
  it('подставляет место ссылки и срок вместо переменных', () => {
    expect(messagePreviewParts('Оплатите 45 000 ₽: {link} до {deadline}', { deadlineText: '12:30 01.11' })).toEqual([
      { kind: 'text', text: 'Оплатите 45 000 ₽: ' },
      { kind: 'link', text: 'ссылка на оплату' },
      { kind: 'text', text: ' до ' },
      { kind: 'deadline', text: '12:30 01.11' },
    ]);
  });

  it('понимает записи Битрикс24 и БП, настоящая ссылка — если известна', () => {
    const parts = messagePreviewParts('A {{Ссылка на оплату}} B {=Variable:paymentlink_new > printable} C {{Оплатить до}}', { link: 'https://x/1' });
    expect(parts.map((p) => p.kind)).toEqual(['text', 'link', 'text', 'link', 'text', 'deadline']);
    expect(parts[1].text).toBe('https://x/1');
    expect(parts[5].text).toBe('срок оплаты');
  });

  it('без переменной ссылки — ссылка последней строкой, как при отправке', () => {
    expect(messagePreviewParts('Ждём оплату')).toEqual([
      { kind: 'text', text: 'Ждём оплату' },
      { kind: 'text', text: '\n' },
      { kind: 'link', text: 'ссылка на оплату' },
    ]);
    expect(messagePreviewParts('')).toEqual([]);
  });

  it('{{СсылкаНаОплату}} из встройки сделки — тоже ссылка', () => {
    expect(messagePreviewParts('Просим Вам произвести оплату {{СсылкаНаОплату}}').map((p) => p.kind)).toEqual(['text', 'link']);
  });
});

describe('deadlinePreview', () => {
  it('«ЧЧ:ММ ДД.ММ» в зоне портала через minutes минут', () => {
    const now = Date.parse('2026-10-31T21:30:00Z');
    expect(deadlinePreview(90, 'Europe/Moscow', now)).toBe('02:00 01.11');
    expect(deadlinePreview(null, 'Europe/Moscow', now)).toBe('');
  });
});
