import { describe, expect, it } from 'vitest';
import type { ContactCompareFieldDto, DuplicateContactDto, DuplicateGroupDto } from '@btx24/shared';
import { contactPills, contactsWord, defaultChoice, fmtPhone, groupForMerge, mergeBlocker, splitGroup, stackView } from './ContactDuplicatesBlock.js';

const field = (values: Record<string, string | null>): ContactCompareFieldDto => ({ code: 'POST', label: 'Должность', kind: 'single', values, conflict: true });

describe('Дубли контактов', () => {
  it('телефон: 11 цифр с 7 — по-русски, иначе как есть', () => {
    expect(fmtPhone('79991234567')).toBe('+7 999 123-45-67');
    expect(fmtPhone('12345')).toBe('12345');
  });
  it('значение по умолчанию — у основного, если заполнено; иначе первое заполненное', () => {
    expect(defaultChoice(field({ 1: 'A', 2: 'B' }), 2, [2, 1])).toBe(2);
    expect(defaultChoice(field({ 1: 'A', 2: null }), 2, [2, 1])).toBe(1);
    expect(defaultChoice(field({ 1: ' ', 2: '' }), 2, [2, 1])).toBe(2);
  });
  it('«N контактов» — склонение', () => {
    expect([1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111].map(contactsWord)).toEqual([
      '1 контакт', '2 контакта', '4 контакта', '5 контактов', '11 контактов', '12 контактов', '14 контактов', '21 контакт', '22 контакта', '25 контактов', '101 контакт', '111 контактов',
    ]);
  });

  const ct = (id: number): DuplicateContactDto => ({ id, name: `К${id}`, phones: [], emails: [], createdAt: null, modifiedAt: null, assignedById: null });
  const group: DuplicateGroupDto = { key: 'p-1', reasons: [{ kind: 'phone', value: '79120000001' }], contacts: [1, 2, 3, 4, 5, 6].map(ct) };

  it('первый — самый ранний из неотмеченных, остальные — в стопку по порядку', () => {
    const all = splitGroup(group.contacts, new Set());
    expect(all.first?.id).toBe(1);
    expect(all.rest.map((c) => c.id)).toEqual([2, 3, 4, 5, 6]);
    const some = splitGroup(group.contacts, new Set([1, 3]));
    expect(some.first?.id).toBe(2);
    expect(some.rest.map((c) => c.id)).toEqual([4, 5, 6]);
    expect(splitGroup(group.contacts, new Set([1, 2, 3, 4, 5, 6])).first).toBeNull();
  });

  it('стопка: до 4 аватарок, иначе 3 + «+N»', () => {
    expect(stackView([1, 2, 3])).toEqual({ shown: [1, 2, 3], more: 0 });
    expect(stackView([1, 2, 3, 4])).toEqual({ shown: [1, 2, 3, 4], more: 0 });
    expect(stackView([1, 2, 3, 4, 5])).toEqual({ shown: [1, 2, 3], more: 2 });
  });

  it('«Не объединять»: в окно сравнения — только оставшиеся; меньше двух — нельзя', () => {
    expect(groupForMerge(group, new Set([2, 5])).contacts.map((c) => c.id)).toEqual([1, 3, 4, 6]);
    expect(groupForMerge(group, new Set([2, 5])).key).toBe('p-1');
    expect(mergeBlocker(2)).toBeNull();
    expect(mergeBlocker(1)).toMatch(/минимум 2/);
    expect(mergeBlocker(0)).toMatch(/минимум 2/);
    expect(mergeBlocker(11)).toMatch(/не больше 10/);
  });
  it('телефон/почта в карточке: до двух, остальное «+N»', () => {
    expect(contactPills({ phones: ['79120000001', '79120000002'], emails: ['a@b.ru'] })).toEqual({
      shown: [{ kind: 'phone', text: '+7 912 000-00-01' }, { kind: 'phone', text: '+7 912 000-00-02' }],
      more: 1,
    });
    expect(contactPills({ phones: [], emails: ['a@b.ru'] }, 1)).toEqual({ shown: [{ kind: 'email', text: 'a@b.ru' }], more: 0 });
    expect(contactPills({ phones: [], emails: [] })).toEqual({ shown: [], more: 0 });
  });
});
