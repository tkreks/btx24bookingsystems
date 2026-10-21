import { describe, expect, it } from 'vitest';
import { clientResourceName, detectBookingType, PROGRAM_FROM_KEYWORD, renderTemplate, unknownVariables, type BookingTypeRule } from './client-messages.js';

const rule = (id: string, keywords: string[], program = ''): BookingTypeRule => ({ id, title: id, keywords, dealTypeValue: '', program, confirmation: [] });
const rules = [
  rule('programs', ['Алатырь', 'Мужской круг'], PROGRAM_FROM_KEYWORD),
  rule('daily', ['Суточная'], 'Суточная аренда дома на воде'),
  rule('hourly', ['Почасовая']),
];

describe('client messages', () => {
  it('detects the booking type by product names, first rule wins, program from keyword', () => {
    expect(detectBookingType(rules, ['Программа «мужской КРУГ» 3 часа'])).toMatchObject({ rule: { id: 'programs' }, program: 'Мужской круг' });
    expect(detectBookingType(rules, ['Суточная аренда', 'Почасовая'])).toMatchObject({ rule: { id: 'daily' }, program: 'Суточная аренда дома на воде' });
    expect(detectBookingType(rules, ['Веник'])).toBeNull();
    expect(detectBookingType([rule('x', ['  '])], ['что угодно'])).toBeNull();
  });

  it('renders variables, keeps unknown and empty ones visible', () => {
    expect(renderTemplate('Бронь на {client_name}: {house}, {date_start} {time_start}, гостей {guests}', { client_name: 'Анна', house: 'Дом знахаря', date_start: '23.10.2026', time_start: '14:00', guests: 4 })).toBe('Бронь на Анна: Дом знахаря, 23.10.2026 14:00, гостей 4');
    expect(renderTemplate('{program} {nope}', { program: '' })).toBe('{program} {nope}');
    expect(unknownVariables('{house} {hause} {house}')).toEqual(['hause']);
  });

  it('uses the alternative resource name when set', () => {
    expect(clientResourceName({ name: 'Баня 3', clientName: 'Дом знахаря' })).toBe('Дом знахаря');
    expect(clientResourceName({ name: 'Баня 3', clientName: '  ' })).toBe('Баня 3');
    expect(clientResourceName({ name: 'Баня 3' })).toBe('Баня 3');
  });
});
