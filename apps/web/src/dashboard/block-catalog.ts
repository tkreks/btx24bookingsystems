import { DASHBOARD_BLOCKS, type BlockWidth, type DashboardBlockGroup, type DashboardBlockType } from '@btx24/shared';

/** Разделы каталога в порядке показа. */
export const CATALOG_GROUPS: DashboardBlockGroup[] = ['Показатели', 'Списки', 'По дням и сравнение', 'Контроль'];

/** Доля ряда, которую занимает блок (сетка дашборда — 60 колонок, см. BlockGrid). */
export const WIDTH_SHARE: Record<BlockWidth, number> = { sixth: 1 / 6, fifth: 1 / 5, quarter: 1 / 4, third: 1 / 3, half: 1 / 2, full: 1 };
export const WIDTH_ICONS: Record<BlockWidth, string> = { sixth: '⅙', fifth: '⅕', quarter: '¼', third: '⅓', half: '½', full: '▭' };

/** Шаблоны эскизов в каталоге: как выглядит блок (BlockPreview рисует каждый). */
export type PreviewKind =
  | 'stat'
  | 'compare'
  | 'list'
  | 'chart'
  | 'sources'
  | 'timeline'
  | 'kpi'
  | 'log'
  | 'people'
  | 'activity'
  | 'messengers'
  | 'duplicates'
  | 'alerts'
  | 'certificates'
  | 'stops';

export type PreviewTone = 'primary' | 'ok' | 'danger' | 'warn';

export interface BlockPreviewSpec {
  kind: PreviewKind;
  tone?: PreviewTone;
  /** Крупное число показателя (`stat`, `compare`); два числа через « / » — сегодня и завтра. */
  value?: string;
  /** Список: что слева в строке. */
  lead?: 'chat' | 'phone' | 'deal' | 'time' | 'avatar';
  /** Список: что справа в строке. */
  trail?: 'badge' | 'time' | 'amount' | 'status' | 'warn' | 'check';
  /** Список: строки зачёркнуты (снятые брони). */
  strike?: boolean;
  /** График столбиками, а не линиями. */
  bars?: boolean;
  /** Сравнение: стрелка вниз (рост — плохо: пропущенные, упущенные). */
  down?: boolean;
  /** Шкала: только текущие — линия «сейчас» и подсвеченные идущие брони. */
  now?: boolean;
  /** Журнал: только свои действия (одна аватарка). */
  mine?: boolean;
}

/** Эскиз каждого типа блока — суть блока, а не его данные. */
export const BLOCK_PREVIEWS: Record<DashboardBlockType, BlockPreviewSpec> = {
  bookingDays: { kind: 'stat', value: '12 / 9', tone: 'primary' },
  callsTotal: { kind: 'stat', value: '48', lead: 'phone', tone: 'primary' },
  newDeals: { kind: 'stat', value: '17', lead: 'deal', tone: 'primary' },
  repeatClients: { kind: 'stat', value: '5', lead: 'avatar', tone: 'ok' },
  attention: { kind: 'list', lead: 'chat', trail: 'badge', tone: 'danger' },
  recentCalls: { kind: 'list', lead: 'phone', trail: 'time', tone: 'primary' },
  deals: { kind: 'list', lead: 'deal', trail: 'amount', tone: 'primary' },
  todayBookings: { kind: 'list', lead: 'time', trail: 'status', tone: 'primary' },
  dealSources: { kind: 'sources', tone: 'primary' },
  newBookings: { kind: 'list', lead: 'time', trail: 'amount', tone: 'ok' },
  removedBookings: { kind: 'list', lead: 'time', trail: 'amount', tone: 'danger', strike: true },
  headNewDeals: { kind: 'compare', value: '64', tone: 'primary' },
  headBookedDeals: { kind: 'compare', value: '38%', tone: 'ok' },
  headRepeat: { kind: 'compare', value: '11', tone: 'primary' },
  headCalls: { kind: 'compare', value: '212', tone: 'primary' },
  headMissed: { kind: 'compare', value: '9', tone: 'danger', down: true },
  headLost: { kind: 'compare', value: '3', tone: 'danger', down: true },
  dealsChart: { kind: 'chart', tone: 'primary' },
  callsChart: { kind: 'chart', tone: 'primary', bars: true },
  activity: { kind: 'activity', tone: 'primary' },
  noOpenline: { kind: 'list', lead: 'deal', trail: 'warn', tone: 'warn' },
  noContact: { kind: 'list', lead: 'deal', trail: 'warn', tone: 'danger' },
  actionLog: { kind: 'log', tone: 'primary' },
  myActivity: { kind: 'log', tone: 'primary', mine: true },
  onShift: { kind: 'people', tone: 'ok' },
  needsClose: { kind: 'list', lead: 'deal', trail: 'check', tone: 'warn' },
  alerts: { kind: 'alerts', tone: 'warn' },
  certificates: { kind: 'certificates', tone: 'primary' },
  stops: { kind: 'stops', tone: 'danger' },
  messengers: { kind: 'messengers', tone: 'ok' },
  kpiGrid: { kind: 'kpi', tone: 'primary' },
  resourceTimeline: { kind: 'timeline', tone: 'primary' },
  upcomingBookings: { kind: 'list', lead: 'time', trail: 'amount', tone: 'primary' },
  currentBookings: { kind: 'list', lead: 'time', trail: 'status', tone: 'ok' },
  resourceTimelineNow: { kind: 'timeline', tone: 'primary', now: true },
  contactDuplicates: { kind: 'duplicates', tone: 'primary' },
  awaitingInvoices: { kind: 'list', lead: 'deal', trail: 'time', tone: 'warn' },
};

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

/** Подходит ли блок под поиск: каждое слово запроса есть в названии, подсказке или разделе. */
export function matchesQuery(type: DashboardBlockType, query: string): boolean {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const m = DASHBOARD_BLOCKS[type];
  const text = norm(`${m.title} ${m.hint} ${m.group}`);
  return words.every((w) => text.includes(w));
}

/** Блоки каталога для раздела (`null` — все) и поиска, в порядке разделов. */
export function filterCatalog(types: readonly DashboardBlockType[], query: string, group: DashboardBlockGroup | null): DashboardBlockType[] {
  const rank = (t: DashboardBlockType) => CATALOG_GROUPS.indexOf(DASHBOARD_BLOCKS[t].group);
  return types
    .filter((t) => (!group || DASHBOARD_BLOCKS[t].group === group) && matchesQuery(t, query))
    .map((t, i) => ({ t, i }))
    .sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i)
    .map((x) => x.t);
}

/** Счётчики разделов под текущий поиск: `all` и по каждому разделу. */
export function catalogCounts(types: readonly DashboardBlockType[], query: string): { all: number } & Record<DashboardBlockGroup, number> {
  const counts = { all: 0, Показатели: 0, Списки: 0, 'По дням и сравнение': 0, Контроль: 0 };
  for (const t of types) {
    if (!matchesQuery(t, query)) continue;
    counts.all++;
    counts[DASHBOARD_BLOCKS[t].group]++;
  }
  return counts;
}

/** Следующая карточка в сетке по клавише (стрелки, Home/End); `null` — клавиша не про перемещение. */
export function gridStep(index: number, key: string, cols: number, length: number): number | null {
  if (!length) return null;
  const c = Math.max(1, cols);
  const to =
    key === 'ArrowRight' ? index + 1 : key === 'ArrowLeft' ? index - 1 : key === 'ArrowDown' ? index + c : key === 'ArrowUp' ? index - c : key === 'Home' ? 0 : key === 'End' ? length - 1 : null;
  if (to === null) return null;
  return Math.min(length - 1, Math.max(0, to));
}
