import { describe, expect, it } from 'vitest';
import { withPaymentLink, type MyGroupDto } from '@btx24/shared';
import { dealGroups } from './DealHome.js';
import { parseHours } from '../bookings/CustomPaymentForm.js';

describe('произвольная оплата', () => {
  it('срок — пусто (без срока) или целое 1–24', () => {
    expect(parseHours('')).toBeNull();
    expect(parseHours('3')).toBe(3);
    expect(parseHours('25')).toBe('invalid');
    expect(parseHours('1.5')).toBe('invalid');
  });
  it('{{СсылкаНаОплату}} — ссылкой; без переменной — ссылка в конце', () => {
    expect(withPaymentLink('Просим Вам произвести оплату {{СсылкаНаОплату}}', 'https://p/x')).toBe('Просим Вам произвести оплату https://p/x');
    expect(withPaymentLink('Оплатите', 'https://p/x')).toBe('Оплатите\nhttps://p/x');
  });
});

describe('шкала во встройке сделки', () => {
  const g = (id: string, dealCategoryId: number | null, view = true) => ({ id, dealCategoryId, permissions: view ? ['calendar.view'] : [] }) as unknown as MyGroupDto;
  it('группы воронки сделки; воронка неизвестна — все', () => {
    const groups = [g('a', 1), g('b', 2), g('c', 1, false), g('d', 1)];
    expect(dealGroups(groups, 1)).toEqual(['a', 'd']);
    expect(dealGroups(groups, undefined)).toEqual([]);
  });
});

describe('linkTimeLeft', () => {
  it('formats the time the payment link still works', async () => {
    const { linkTimeLeft } = await import('./ClientInvoicesBlock.js');
    const now = Date.parse('2026-10-26T10:00:00Z');
    expect(linkTimeLeft(null, now)).toBe('');
    expect(linkTimeLeft('2026-10-26T11:20:30Z', now)).toBe('ещё 1 ч 20 мин');
    expect(linkTimeLeft('2026-10-26T12:00:00Z', now)).toBe('ещё 2 ч');
    expect(linkTimeLeft('2026-10-26T10:12:00Z', now)).toBe('ещё 12 мин');
    expect(linkTimeLeft('2026-10-26T10:00:30Z', now)).toBe('меньше минуты');
    expect(linkTimeLeft('2026-10-26T09:59:00Z', now)).toBe('срок вышел');
  });
});
