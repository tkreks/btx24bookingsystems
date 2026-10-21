import type { CalendarView, MyGroupDto } from '@btx24/shared';

/** Как в прототипе: телефон и узкое окно — до 860 px. */
export const isNarrow = () => {
  try {
    return (
      window.matchMedia('(max-width: 860px)').matches || /iPhone|iPad|iPod|Android|Mobile/i.test(navigator.userAgent)
    );
  } catch {
    return false;
  }
};

const ORDER: CalendarView[] = ['calendar', 'list', 'availability'];
export const VIEW_TITLES: Record<CalendarView, string> = {
  calendar: 'Календарь',
  list: 'Список',
  availability: 'Доступность',
};
export const VIEW_ICONS: Record<CalendarView, string> = { calendar: '▦', list: '☰', availability: '▤' };

/** Кнопка вида по кругу: календарь → список → доступность → календарь. */
export const nextView = (v: CalendarView): CalendarView => ORDER[(ORDER.indexOf(v) + 1) % ORDER.length];

export function parseView(raw: string | null): CalendarView | null {
  if (raw === 'grid') return 'calendar'; // сохранено прежней версией
  return ORDER.includes(raw as CalendarView) ? (raw as CalendarView) : null;
}

/**
 * Вид при выборе группы (правила прототипа): заданный в группе вид для устройства — всегда;
 * иначе, если пользователь сам переключал вид, — оставляем; иначе «заезд/выезд» → доступность,
 * а доступность для почасовой группы меняем на вид устройства.
 */
export function viewForGroup(
  group: Pick<MyGroupDto, 'views' | 'bookingMode'> | null,
  current: CalendarView,
  userChosen: boolean,
  narrow: boolean,
): CalendarView {
  const preset = group ? (narrow ? group.views.mobile : group.views.desktop) : '';
  if (preset) return preset;
  if (userChosen) return current;
  if (group?.bookingMode === 'interval') return 'availability';
  if (current === 'availability') return narrow ? 'list' : 'calendar';
  return current;
}
