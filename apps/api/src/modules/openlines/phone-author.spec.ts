import { phoneAuthorAt } from './activity.service.js';

describe('автор сообщения «с телефона» по сменам', () => {
  const people = new Map([[7, { name: 'Максим', photo: 'https://p/7.jpg' }], [8, { name: 'Елена', photo: null }]]);
  const at = Date.parse('2026-10-27T10:00:00Z');
  const shift = (userId: number, start: string, end: string | null) => ({ userId, start: Date.parse(start), end: end ? Date.parse(end) : null });

  it('на смене один сотрудник — его имя и фото', () => {
    expect(phoneAuthorAt([shift(7, '2026-10-27T06:00:00Z', null), shift(8, '2026-10-27T11:00:00Z', null)], people, at)).toEqual({ userId: 7, name: 'Максим', avatar: 'https://p/7.jpg', phone: 'shift' });
  });

  it('на смене несколько — спорно, с перечислением', () => {
    expect(phoneAuthorAt([shift(7, '2026-10-27T06:00:00Z', null), shift(8, '2026-10-27T09:00:00Z', null)], people, at)).toEqual({ name: 'Спорно: на смене Максим, Елена', phone: 'shared' });
  });

  it('смены нет (даже если днём кто-то работал) — «Телефон», автор неизвестен', () => {
    expect(phoneAuthorAt([shift(7, '2026-10-27T11:00:00Z', '2026-10-27T15:00:00Z')], people, at)).toEqual({ name: 'Телефон', phone: 'unknown' });
  });
});
