import { describe, expect, it } from 'vitest';
import { progressLabel, progressOf } from './LoadProgress.js';

describe('примерный прогресс загрузки', () => {
  it('растёт к 80% за обычное время и не доходит до 100%, пока данных нет', () => {
    expect(progressOf(0, 4000)).toBe(0);
    expect(progressOf(2000, 4000)).toBeCloseTo(0.4);
    expect(progressOf(4000, 4000)).toBeCloseTo(0.8);
    expect(progressOf(60_000, 4000)).toBeLessThanOrEqual(0.95);
  });

  it('подпись: сколько осталось, потом «почти готово», потом «дольше обычного»', () => {
    expect(progressLabel(1000, 4000)).toBe('≈20% · осталось ~3 с');
    expect(progressLabel(5000, 4000)).toMatch(/почти готово/);
    expect(progressLabel(9000, 4000)).toMatch(/дольше обычного/);
  });
});
