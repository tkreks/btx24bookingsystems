import { describe, expect, it } from 'vitest';
import { DASHBOARD_BLOCK_TYPES, DASHBOARD_BLOCKS, type DashboardBlockType } from '@btx24/shared';
import { BLOCK_PREVIEWS, CATALOG_GROUPS, catalogCounts, filterCatalog, gridStep, matchesQuery } from './block-catalog.js';

describe('Каталог блоков дашборда', () => {
  it('у каждого типа блока есть эскиз, у каждого раздела — место в списке', () => {
    for (const t of DASHBOARD_BLOCK_TYPES) {
      expect(BLOCK_PREVIEWS[t], t).toBeDefined();
      expect(CATALOG_GROUPS).toContain(DASHBOARD_BLOCKS[t].group);
    }
  });

  it('эскиз отражает суть блока', () => {
    expect(BLOCK_PREVIEWS.resourceTimeline.kind).toBe('timeline');
    expect(BLOCK_PREVIEWS.resourceTimelineNow).toMatchObject({ kind: 'timeline', now: true });
    expect(BLOCK_PREVIEWS.kpiGrid.kind).toBe('kpi');
    expect(BLOCK_PREVIEWS.callsChart).toMatchObject({ kind: 'chart', bars: true });
    expect(BLOCK_PREVIEWS.contactDuplicates.kind).toBe('duplicates');
    expect(BLOCK_PREVIEWS.messengers.kind).toBe('messengers');
    expect(BLOCK_PREVIEWS.myActivity).toMatchObject({ kind: 'log', mine: true });
  });

  it('поиск — по названию, подсказке и разделу, без учёта регистра и «ё», все слова', () => {
    expect(matchesQuery('recentCalls', 'ЗВОНКИ')).toBe(true);
    expect(matchesQuery('stops', 'закрытые ресурсы')).toBe(true);
    expect(matchesQuery('contactDuplicates', 'объединение')).toBe(true);
    expect(matchesQuery('stops', 'закрытые звонки')).toBe(false);
    expect(matchesQuery('dealSources', 'ещё')).toBe(false);
    expect(matchesQuery('attention', '  ')).toBe(true);
  });

  it('фильтр по разделу и поиску сохраняет порядок разделов', () => {
    const types: DashboardBlockType[] = ['stops', 'attention', 'callsTotal', 'recentCalls', 'headCalls'];
    expect(filterCatalog(types, '', null)).toEqual(['callsTotal', 'attention', 'recentCalls', 'headCalls', 'stops']);
    expect(filterCatalog(types, '', 'Списки')).toEqual(['attention', 'recentCalls']);
    expect(filterCatalog(types, 'звонк', null)).toEqual(['callsTotal', 'recentCalls', 'headCalls']);
    expect(filterCatalog(types, 'звонк', 'Контроль')).toEqual([]);
  });

  it('счётчики разделов учитывают поиск', () => {
    const c = catalogCounts(['stops', 'attention', 'callsTotal', 'recentCalls', 'headCalls'], 'звонк');
    expect(c).toEqual({ all: 3, Показатели: 1, Списки: 1, 'По дням и сравнение': 1, Контроль: 0 });
  });

  it('стрелки по сетке карточек', () => {
    expect(gridStep(0, 'ArrowRight', 3, 7)).toBe(1);
    expect(gridStep(0, 'ArrowLeft', 3, 7)).toBe(0);
    expect(gridStep(1, 'ArrowDown', 3, 7)).toBe(4);
    expect(gridStep(5, 'ArrowDown', 3, 7)).toBe(6);
    expect(gridStep(4, 'ArrowUp', 3, 7)).toBe(1);
    expect(gridStep(3, 'End', 3, 7)).toBe(6);
    expect(gridStep(3, 'Home', 3, 7)).toBe(0);
    expect(gridStep(3, 'Enter', 3, 7)).toBeNull();
    expect(gridStep(0, 'ArrowDown', 3, 0)).toBeNull();
  });
});
