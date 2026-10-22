/** Запись журнала действий (⚙ → «Журнал действий»): `GET /api/admin/action-log`. */
export interface ActionLogEntryDto {
  id: string;
  at: string;
  actorKind: 'user' | 'system' | 'bitrix';
  userId: number | null;
  actorName: string | null;
  /** Код действия: `app.enter`, `deal.edit_open`, `deal.update`, `booking.cancelled`, `request` … */
  action: string;
  entityType: string | null;
  entityId: string | null;
  summary: string;
  /** Подробности: `changes: [{field, label, before, after}]`, контекст, параметры запроса. */
  details: unknown;
  via: string | null;
}

export interface ActionLogDto {
  items: ActionLogEntryDto[];
  /** Следующая страница (старше): передать как `before`; null — дальше записей нет. */
  nextCursor: string | null;
}

/** `POST /api/activity/enter` — сотрудник открыл приложение (откуда). */
/** `POST /api/activity/error` — интерфейс упал: где, текст и трасса (для журнала). */
export interface ClientErrorDto {
  where: string;
  message: string;
  stack: string;
  build: string;
}

export interface AppEnterDto {
  placement: string;
  dealId: number | null;
}
