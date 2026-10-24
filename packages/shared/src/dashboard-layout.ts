// Личный дашборд (решение владельца 2026-10-24): каждый сотрудник собирает свой дашборд из блоков —
// порядок и ширина (⅙, ⅕, ¼, ⅓, ½, весь ряд). Блоки бывшего дашборда руководителя — в
// общем каталоге; «Активность сотрудников» — только администраторам приложения.

export const BLOCK_WIDTHS = ['sixth', 'fifth', 'quarter', 'third', 'half', 'full'] as const;
export type BlockWidth = (typeof BLOCK_WIDTHS)[number];
export const BLOCK_WIDTH_LABELS: Record<BlockWidth, string> = { sixth: 'Шестая часть', fifth: 'Пятая часть', quarter: 'Четверть', third: 'Треть', half: 'Половина', full: 'Весь ряд' };

export const DASHBOARD_BLOCK_TYPES = [
  // Показатели менеджера («Чатов ждут ответа» убран 2026-10-24: «Открыть чаты» — в «Сообщениях без ответа»)
  'bookingDays',
  'callsTotal',
  'newDeals',
  'repeatClients',
  // Списки
  'attention',
  'recentCalls',
  'deals',
  'todayBookings',
  'dealSources',
  'newBookings',
  'removedBookings',
  // Показатели по дням (бывший дашборд руководителя)
  'headNewDeals',
  'headBookedDeals',
  'headRepeat',
  'headCalls',
  'headMissed',
  'headLost',
  'dealsChart',
  'callsChart',
  'activity',
  // Новые
  'noOpenline',
  'noContact',
  'actionLog',
  'myActivity',
  'onShift',
  'needsClose',
  'alerts',
  'certificates',
  'stops',
  'messengers',
] as const;
export type DashboardBlockType = (typeof DASHBOARD_BLOCK_TYPES)[number];

export type DashboardBlockGroup = 'Показатели' | 'Списки' | 'По дням и сравнение' | 'Контроль';

export interface DashboardBlockMeta {
  title: string;
  hint: string;
  group: DashboardBlockGroup;
  width: BlockWidth;
  /** Только администраторам приложения (остальные блок не видят и добавить не могут). */
  adminOnly?: boolean;
}

export const DASHBOARD_BLOCKS: Record<DashboardBlockType, DashboardBlockMeta> = {
  bookingDays: { title: 'Бронирований сегодня / завтра', hint: 'брони на ресурсах ваших групп, окно «Календарь»', group: 'Показатели', width: 'quarter' },
  callsTotal: { title: 'Все звонки', hint: 'звонков за период, переход к звонкам', group: 'Показатели', width: 'quarter' },
  newDeals: { title: 'Новых сделок', hint: 'созданные за период в воронках ваших групп', group: 'Показатели', width: 'quarter' },
  repeatClients: { title: 'Повторные клиенты', hint: 'новые сделки клиентов, у которых уже была состоявшаяся', group: 'Показатели', width: 'quarter' },
  attention: { title: 'Сообщения без ответа', hint: 'последние сообщения клиентов, на которые не ответили; «Открыть чаты»', group: 'Списки', width: 'half' },
  recentCalls: { title: 'Звонки', hint: 'последние звонки периода', group: 'Списки', width: 'half' },
  deals: { title: 'Сделки', hint: 'созданные за период и с оплатой за период', group: 'Списки', width: 'half' },
  todayBookings: { title: 'Брони сегодня', hint: 'сделки с бронью на сегодня: прошла, идёт, впереди', group: 'Списки', width: 'half' },
  dealSources: { title: 'Источники новых сделок', hint: 'сколько сделок пришло из каждого источника', group: 'Списки', width: 'full' },
  newBookings: { title: 'Новые бронирования', hint: 'появились за период (приложение и Битрикс24)', group: 'Списки', width: 'half' },
  removedBookings: { title: 'Удалённые бронирования', hint: 'сняты за период: не оплачены, удалены', group: 'Списки', width: 'half' },
  headNewDeals: { title: 'Новые сделки — сравнение', hint: 'все воронки групп, с прошлым периодом', group: 'По дням и сравнение', width: 'third' },
  headBookedDeals: { title: 'Брони по новым сделкам', hint: 'конверсия новых сделок в бронь, с прошлым периодом', group: 'По дням и сравнение', width: 'third' },
  headRepeat: { title: 'Сделки повторных клиентов', hint: 'у клиента раньше была бронь', group: 'По дням и сравнение', width: 'third' },
  headCalls: { title: 'Звонков — сравнение', hint: 'входящие и исходящие, с прошлым периодом', group: 'По дням и сравнение', width: 'third' },
  headMissed: { title: 'Пропущенных', hint: 'входящие без ответа, с прошлым периодом', group: 'По дням и сравнение', width: 'third' },
  headLost: { title: 'Упущенных клиентов', hint: 'не перезвонили и не написали в чат', group: 'По дням и сравнение', width: 'third' },
  dealsChart: { title: 'График сделок', hint: 'новые, с бронью, повторные — по дням', group: 'По дням и сравнение', width: 'half' },
  callsChart: { title: 'График звонков', hint: 'все, пропущенные, упущенные — по дням', group: 'По дням и сравнение', width: 'half' },
  activity: { title: 'Активность сотрудников', hint: 'рабочий день, звонки и сообщения каждого сотрудника', group: 'По дням и сравнение', width: 'full', adminOnly: true },
  noOpenline: { title: 'Сделки без открытой линии', hint: 'открытые сделки без чата у сделки и её контакта', group: 'Контроль', width: 'half' },
  noContact: { title: 'Сделки без контакта', hint: 'открытые сделки без привязанного контакта', group: 'Контроль', width: 'half' },
  onShift: { title: 'Кто на смене?', hint: 'сотрудники на работе, последняя активность и управление своим рабочим днём', group: 'Списки', width: 'half' },
  myActivity: { title: 'Журнал моих действий', hint: 'только ваши звонки, сообщения и действия за выбранный период', group: 'Списки', width: 'half' },
  actionLog: { title: 'Журнал действий', hint: 'действия сотрудников и системы за выбранный период', group: 'Контроль', width: 'full', adminOnly: true },
  needsClose: { title: 'Сделки к закрытию', hint: 'бронь прошла, а сделка в Битрикс24 ещё в работе', group: 'Контроль', width: 'half' },
  alerts: { title: 'Уведомления о бронях', hint: 'новые уведомления: расхождения с Битрикс24, найденные брони', group: 'Контроль', width: 'quarter' },
  certificates: { title: 'Сертификаты', hint: 'новые, срок прошёл — погасить', group: 'Контроль', width: 'quarter' },
  stops: { title: 'Стопы ресурсов', hint: 'ресурсы, закрытые для бронирования', group: 'Контроль', width: 'half' },
  messengers: { title: 'Мессенджеры', hint: 'номера ваших групп: работают или с ошибкой; экран мессенджера и файлы для отправки', group: 'Контроль', width: 'quarter' },
};

export interface DashboardBlock {
  /** Свой ID блока на дашборде (один тип можно добавить один раз). */
  id: string;
  type: DashboardBlockType;
  width: BlockWidth;
  /** Высота в рядах сетки: 2 — блок на высоту двух рядов (по умолчанию 1). */
  rows?: 1 | 2;
}

/** `GET/PUT /api/dashboard/layout` */
export interface DashboardLayoutDto {
  blocks: DashboardBlock[];
  /** true — сотрудник ещё не настраивал, это раскладка по умолчанию. */
  isDefault: boolean;
}

const block = (type: DashboardBlockType, width: BlockWidth = DASHBOARD_BLOCKS[type].width): DashboardBlock => ({ id: type, type, width });

/** Раскладка по умолчанию — как был дашборд менеджера, плюс блоки контроля. */
export const DEFAULT_DASHBOARD: DashboardBlock[] = [
  block('onShift'),
  block('bookingDays'),
  block('callsTotal'),
  block('newDeals'),
  block('repeatClients'),
  block('needsClose', 'quarter'),
  block('alerts'),
  block('certificates'),
  block('messengers'),
  block('attention'),
  block('deals'),
  block('recentCalls'),
  block('todayBookings'),
  block('dealSources'),
  block('newBookings'),
  block('removedBookings'),
];

/** Блоки, которые сотрудник может видеть и добавлять. */
export function allowedBlocks(isAppAdmin: boolean): DashboardBlockType[] {
  return DASHBOARD_BLOCK_TYPES.filter((t) => isAppAdmin || !DASHBOARD_BLOCKS[t].adminOnly);
}

/** «Сделки к закрытию»: бронь прошла, а сделка в канбане ещё в работе. */
export interface NeedsCloseDto {
  counts: { mine: number; all: number };
  items: { dealId: number; title: string; client: string | null; opportunity: number | null; currency: string | null; bookingEnd: string }[];
}


export interface DashboardGapsDto {
  kind: 'chat' | 'contact';
  items: { dealId: number; title: string; contactId: number | null; createdAt: string | null; opportunity: number | null; currency: string | null }[];
  notes: string[];
}
