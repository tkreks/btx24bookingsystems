import { describe, expect, it } from 'vitest';
import { timelineDays } from './ResourceTimelineBlock.js';

describe('шкала броней: дни от сегодня до конца периода', () => {
  it('сегодня → конец периода, не больше недели', () => {
    expect(timelineDays('2026-10-25', '2026-10-25')).toEqual(['2026-10-25']);
    expect(timelineDays('2026-10-25', '2026-10-27')).toEqual(['2026-10-25', '2026-10-26', '2026-10-27']);
    expect(timelineDays('2026-10-25', '2026-11-30')).toHaveLength(7);
  });
  it('прошедший период (вчера) — только сегодня', () => {
    expect(timelineDays('2026-10-25', '2026-10-24')).toEqual(['2026-10-25']);
  });
});
