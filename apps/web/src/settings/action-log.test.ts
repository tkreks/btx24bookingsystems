import { describe, expect, it } from 'vitest';
import { parseEntity } from './ActionLogPanel.js';

describe('parseEntity — поиск объекта в журнале действий', () => {
  it('«сделка 678», «бронь #555», «чат 50580», просто номер', () => {
    expect(parseEntity('сделка 678')).toEqual({ entityType: 'deal', entityId: '678' });
    expect(parseEntity('Бронь #555')).toEqual({ entityType: 'booking', entityId: '555' });
    expect(parseEntity('чат 50580')).toEqual({ entityType: 'chat', entityId: '50580' });
    expect(parseEntity('678')).toEqual({ entityId: '678' });
  });
  it('не номер — не объект (ищется текстом)', () => {
    expect(parseEntity('Анна')).toEqual({});
  });
});
