import { encodeParams } from './encode-params.js';

describe('encodeParams', () => {
  it('encodes nested objects and arrays PHP-style', () => {
    expect(decodeURIComponent(encodeParams({ filter: { within: { dateFrom: 1, dateTo: 2 } }, select: ['ID', 'TITLE'] }))).toBe(
      'filter[within][dateFrom]=1&filter[within][dateTo]=2&select[0]=ID&select[1]=TITLE',
    );
  });

  it('keeps $result references unencoded and maps booleans to Y/N', () => {
    expect(encodeParams({ id: '$result[deal][ID]', active: true })).toBe('id=$result[deal][ID]&active=Y');
  });

  it('encodes unsafe characters in values', () => {
    expect(encodeParams({ title: 'Бронь & co' })).toBe(`title=${encodeURIComponent('Бронь & co')}`);
  });
});
