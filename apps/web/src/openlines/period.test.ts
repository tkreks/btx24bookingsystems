import { describe, expect, it } from 'vitest';
import { periodError, presetRange } from './period.js';

describe('dashboard period', () => {
  it('presets are whole days ending today', () => {
    expect(presetRange('today', '2026-10-21')).toEqual({ from: '2026-10-21', to: '2026-10-21' });
    expect(presetRange('yesterday', '2026-03-01')).toEqual({ from: '2026-02-28', to: '2026-02-28' });
    expect(presetRange('7d', '2026-10-21')).toEqual({ from: '2026-10-15', to: '2026-10-21' });
    expect(presetRange('30d', '2026-10-21')).toEqual({ from: '2026-09-22', to: '2026-10-21' });
    expect(presetRange('month', '2026-10-21')).toEqual({ from: '2026-10-01', to: '2026-10-21' });
  });

  it('validates custom range', () => {
    expect(periodError('2026-10-01', '2026-10-21')).toBeNull();
    expect(periodError('2026-10-21', '2026-10-01')).toMatch(/позже/);
    expect(periodError('2026-01-01', '2026-10-21')).toMatch(/92/);
    expect(periodError('', '2026-10-21')).toMatch(/обе/);
  });
});
