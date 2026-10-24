// Канбан сделок по числу показателя дашборда (решение владельца 2026-10-25): как канбан Битрикс24 —
// колонки-стадии в порядке воронки, карточки сделок. Только просмотр: переносить между стадиями нельзя.

export interface KanbanStageDto {
  id: string;
  name: string;
  /** Цвет стадии из CRM (`#39A8EF`); null — не задан. */
  color: string | null;
  semantics: 'process' | 'success' | 'failure';
}

export interface KanbanFunnelDto {
  id: number;
  name: string;
  /** Стадии по порядку воронки (SORT). */
  stages: KanbanStageDto[];
}

export interface KanbanDealDto {
  id: number;
  title: string;
  categoryId: number;
  stageId: string;
  opportunity: number | null;
  currency: string | null;
  createdAt: string | null;
  contact: { id: number; name: string | null } | null;
  assigned: { id: number; name: string | null; photo: string | null } | null;
}

/** `GET /api/dashboard/deal-kanban?ids=1,2,3` — до `MAX_KANBAN_DEALS` сделок; недоступные не показываются. */
export interface DealKanbanDto {
  funnels: KanbanFunnelDto[];
  deals: KanbanDealDto[];
  /** Сколько сделок из запрошенных не показано (нет прав или удалены). */
  hidden: number;
}

export const MAX_KANBAN_DEALS = 500;
