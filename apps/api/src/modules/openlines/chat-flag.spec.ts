import { flagOf } from './chats.service.js';

describe('«!» у чата', () => {
  const at = new Date('2026-10-25T10:00:00Z');
  const mark = { flagAt: at, flagByName: 'Анна' };
  it('видна, пока после отметки не написал сотрудник', () => {
    expect(flagOf(mark, 'client', '2026-10-25T10:05:00Z')).toEqual({ byName: 'Анна', at: at.toISOString() });
    expect(flagOf(mark, 'employee', '2026-10-25T09:00:00Z')).not.toBeNull();
    expect(flagOf(mark, 'employee', '2026-10-25T10:01:00Z')).toBeNull();
  });
  it('без отметки — нет', () => {
    expect(flagOf({ flagAt: null, flagByName: null }, 'client', null)).toBeNull();
    expect(flagOf(undefined, 'client', null)).toBeNull();
  });
});
