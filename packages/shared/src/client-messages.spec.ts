import { describe, expect, it } from 'vitest';
import { clientResourceName, defaultPrepaymentSteps, detectBookingType, PROGRAM_FROM_KEYWORD, renderTemplate, unknownVariables, type BookingTypeRule } from './client-messages.js';

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

describe('defaultPrepaymentSteps', () => {
  const files = [{ id: 1, name: 'a.pdf' }, { id: 2, name: 'b.pdf' }];
  const typed = (title: string) => ({ ...rule(title, ['x']), title, confirmation: [{ text: '', files }, { text: 'Подтверждаем', files: [] }] });
  it('бронь и сертификат — свой текст, файлы — из файлового шага подтверждения', () => {
    const [b] = defaultPrepaymentSteps([typed('Почасовая')], 'Почасовая')!;
    expect(b!.text).toContain('забронировать банный дом');
    expect(b!.files).toEqual(files);
    expect(defaultPrepaymentSteps([typed('Сертификат')], 'Сертификат')![0]!.text).toContain('подарочный сертификат');
  });
  it('своё сообщение типа главнее стандартного', () => {
    const own = [{ text: 'Своё {link}', files: [{ id: 5, name: 'c.pdf' }] }];
    expect(defaultPrepaymentSteps([{ ...typed('Почасовая'), prepayment: own }], 'Почасовая')).toEqual(own);
  });
  it('тип не определён — null', () => {
    expect(defaultPrepaymentSteps([typed('Почасовая')], undefined)).toBeNull();
    expect(defaultPrepaymentSteps(undefined, 'Почасовая')).toBeNull();
  });
});
