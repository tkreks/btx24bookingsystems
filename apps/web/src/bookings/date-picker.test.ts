import { describe, expect, it } from 'vitest';
import { monthCells, relativeDay, shiftMonth } from './DatePicker.js';

describe('DatePicker', () => {
  it('сетка месяца — 6 недель с понедельника', () => {
    const cells = monthCells('2026-10');
    expect(cells).toHaveLength(42);
    expect(cells[0]).toBe('2026-09-28');
    expect(cells[3]).toBe('2026-10-01');
    expect(cells[41]).toBe('2026-11-08');
  });

  it('месяц, начинающийся с понедельника, — без дней прошлого месяца', () => {
    expect(monthCells('2026-06')[0]).toBe('2026-06-01');
  });

  it('сдвиг месяца через год', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
  });

  it('относительные дни', () => {
    expect(relativeDay('2026-10-26', '2026-10-26')).toBe('сегодня');
    expect(relativeDay('2026-10-27', '2026-10-26')).toBe('завтра');
    expect(relativeDay('2026-10-25', '2026-10-26')).toBe('вчера');
    expect(relativeDay('2026-11-01', '2026-10-26')).toBeNull();
  });
});
