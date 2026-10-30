import { describe, expect, it } from 'vitest';
import { durationRu } from './PaymentWindow.js';

describe('PaymentWindow — длительность брони', () => {
  it('часы, дни и минуты по-русски', () => {
    expect(durationRu(4 * 3600_000)).toBe('4 часа');
    expect(durationRu(3600_000)).toBe('1 час');
    expect(durationRu(5 * 3600_000)).toBe('5 часов');
    expect(durationRu(26 * 3600_000)).toBe('1 день 2 часа');
    expect(durationRu(45 * 60_000)).toBe('45 мин');
    expect(durationRu(0)).toBe('0 мин');
  });
});
