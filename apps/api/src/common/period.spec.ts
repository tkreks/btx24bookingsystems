import { selectedPeriod } from './period.js';

describe('selectedPeriod', () => {
  it('без дат сохраняет прежний режим', () => expect(selectedPeriod({}, 'Europe/Moscow')).toBeNull());
  it('включает обе локальные даты и исключает следующую полночь', () => {
    const p = selectedPeriod({ from: '2026-10-22', to: '2026-10-24' }, 'Europe/Moscow')!;
    expect(p.start.toISOString()).toBe('2026-10-21T21:00:00.000Z');
    expect(p.end.toISOString()).toBe('2026-10-24T21:00:00.000Z');
  });
  it('учитывает переход часового пояса: день длится 23 часа', () => {
    const p = selectedPeriod({ from: '2026-03-29', to: '2026-03-29' }, 'Europe/Berlin')!;
    expect(p.end.getTime() - p.start.getTime()).toBe(23 * 3600000);
  });
  it.each([{ from: '2026-10-24' }, { from: '2026-10-24', to: '2026-10-23' }, { from: '2026-01-01', to: '2026-04-03' }, { from: 'bad', to: 'bad' }])('отвергает некорректный период %j', (q) => {
    expect(() => selectedPeriod(q, 'Europe/Moscow')).toThrow();
  });
});
