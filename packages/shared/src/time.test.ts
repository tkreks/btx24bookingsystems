import { describe, expect, it } from 'vitest';
import { addDays, previousPeriod } from './time.js';

describe('previousPeriod', () => {
  it('день — предыдущий день', () => expect(previousPeriod('2026-10-01', '2026-10-01')).toEqual({ from: '2026-09-30', to: '2026-09-30' }));
  it('31 день — 31 день перед ним', () => expect(previousPeriod('2026-10-01', '2026-10-31')).toEqual({ from: '2026-08-31', to: '2026-09-30' }));
  it('addDays через месяц', () => expect(addDays('2026-02-27', 3)).toBe('2026-03-02'));
});
