import { formatDealValue } from './deal-fields.js';

describe('formatDealValue', () => {
  const tz = 'Europe/Moscow';
  it.each([
    [
      'enumeration',
      ['1', '2'],
      {
        type: 'enumeration',
        items: [
          { ID: 1, VALUE: 'Баня' },
          { ID: '2', VALUE: 'Домик' },
        ],
      },
      'Баня, Домик',
    ],
    ['boolean', '1', { type: 'boolean' }, 'Да'],
    ['boolean no', '0', { type: 'boolean' }, 'Нет'],
    ['money', '15000|RUB', { type: 'money' }, `${new Intl.NumberFormat('ru-RU').format(15000)} RUB`],
    ['date', '2026-10-21T00:00:00+03:00', { type: 'date' }, '21.10.2026'],
    ['datetime in portal tz', '2026-10-21T11:30:00+00:00', { type: 'datetime' }, '21.10.2026, 14:30'],
    ['string', 'текст', { type: 'string' }, 'текст'],
    ['double', '12000.00', { type: 'double' }, new Intl.NumberFormat('ru-RU').format(12000)],
    ['markup', '<p>Гости [b]4[/b]</p>&nbsp;&quot;А&amp;Б&quot;', { type: 'string' }, 'Гости 4 "А&Б"'],
    ['unknown meta', 7, undefined, '7'],
  ])('%s', (_name, raw, meta, expected) => {
    expect(formatDealValue(raw, meta as never, tz)).toBe(expected);
  });
  it.each([null, '', [], ['']])('treats %o as empty', (raw) => {
    expect(formatDealValue(raw, { type: 'string' }, tz)).toBeNull();
  });
});

it('сложные типы показываются текстом, названия файлов и привязок читаемы', () => {
  expect(formatDealValue({ ID: 7, NAME: 'Договор.pdf' }, { type: 'file' }, 'UTC')).toBe('Договор.pdf');
  expect(formatDealValue({ id: 1 }, { type: 'unknown' }, 'UTC')).toBe('{"id":1}');
});
