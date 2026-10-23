/**
 * Встройки приложения (требования владельца: карточка сделки и левое меню). Обработчик — корень
 * приложения: портал откроет его POST-запросом, контекст встройки интерфейс читает через
 * BX24.placement.info().
 */
export const APP_PLACEMENTS = [
  { placement: 'CRM_DEAL_DETAIL_TAB', title: 'Бронирование' },
  { placement: 'CRM_DEAL_DETAIL_TOOLBAR', title: 'Бронирование' },
  { placement: 'LEFT_MENU', title: 'Бронирование' },
  // Вкладка в карточке звонка (scope `telephony`): клиент, сделки, брони, сообщения, «Создать бронь».
  { placement: 'CALL_CARD', title: 'Бронирование' },
] as const;

export interface PlacementStatus {
  placement: string;
  title: string;
  bound: boolean;
}

/** Встройки и подписки на события звонков (⚙ → «Встройки»). */
export interface PlacementsStateDto {
  placements: PlacementStatus[];
  /** Подписки на события звонков: событие → привязано. */
  events: { event: string; bound: boolean }[];
}
