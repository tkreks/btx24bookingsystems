/**
 * Встройки приложения (требования владельца: карточка сделки и левое меню). Обработчик — корень
 * приложения: портал откроет его POST-запросом, контекст встройки интерфейс читает через
 * BX24.placement.info().
 */
export const APP_PLACEMENTS = [
  { placement: 'CRM_DEAL_DETAIL_TAB', title: 'Бронирование' },
  { placement: 'CRM_DEAL_DETAIL_TOOLBAR', title: 'Бронирование' },
  { placement: 'LEFT_MENU', title: 'Бронирование' },
] as const;

export interface PlacementStatus {
  placement: string;
  title: string;
  bound: boolean;
}
