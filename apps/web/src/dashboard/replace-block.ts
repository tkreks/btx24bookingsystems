import type { DashboardBlock, DashboardBlockType } from '@btx24/shared';

/**
 * Заменить блок `id` на блок типа `type`. Тип уже на панели — блоки меняются местами и размерами;
 * ещё не выведен — новый встаёт на место и в размер прежнего, прежний с панели убирается.
 */
export function replaceBlock(blocks: DashboardBlock[], id: string, type: DashboardBlockType): DashboardBlock[] {
  const i = blocks.findIndex((b) => b.id === id);
  if (i < 0 || blocks[i].type === type) return blocks;
  const a = blocks[i];
  const size = (b: DashboardBlock) => ({ width: b.width, ...(b.rows === 2 ? { rows: 2 as const } : {}) });
  const strip = ({ rows: _rows, ...b }: DashboardBlock) => b;
  const j = blocks.findIndex((b) => b.type === type);
  const next = [...blocks];
  if (j >= 0) {
    next[i] = { ...strip(blocks[j]), ...size(a) };
    next[j] = { ...strip(a), ...size(blocks[j]) };
  } else next[i] = { id: `${type}-${Date.now().toString(36)}`, type, ...size(a) };
  return next;
}
