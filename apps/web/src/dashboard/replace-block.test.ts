import { describe, expect, it } from 'vitest';
import type { DashboardBlock } from '@btx24/shared';
import { replaceBlock } from './replace-block.js';

const layout: DashboardBlock[] = [
  { id: 'a', type: 'attention', width: 'half', rows: 2 },
  { id: 'b', type: 'alerts', width: 'quarter' },
  { id: 'c', type: 'recentCalls', width: 'half' },
];

describe('Замена блока дашборда', () => {
  it('блок уже на панели — меняются местами и размерами', () => {
    expect(replaceBlock(layout, 'a', 'alerts')).toEqual([
      { id: 'b', type: 'alerts', width: 'half', rows: 2 },
      { id: 'a', type: 'attention', width: 'quarter' },
      { id: 'c', type: 'recentCalls', width: 'half' },
    ]);
  });

  it('блок не выведен — встаёт на место и в размер прежнего, прежний убирается', () => {
    const next = replaceBlock(layout, 'b', 'stops');
    expect(next.map((b) => b.type)).toEqual(['attention', 'stops', 'recentCalls']);
    expect(next[1]).toMatchObject({ type: 'stops', width: 'quarter' });
    expect(next[1].rows).toBeUndefined();
  });

  it('тот же тип или неизвестный блок — без изменений', () => {
    expect(replaceBlock(layout, 'a', 'attention')).toBe(layout);
    expect(replaceBlock(layout, 'zzz', 'stops')).toBe(layout);
  });
});
