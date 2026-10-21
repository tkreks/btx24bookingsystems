import type { ReactNode } from 'react';
import type { CalendarDay } from '@btx24/shared';
import { fmtDayTitle } from '../format.js';

/** Заголовок дня в списке и доступности: дата, группа, справа — сводка или легенда. */
export function DayHeader({ day, groupName, children }: { day: CalendarDay; groupName: string; children: ReactNode }) {
  return (
    <div className="day-header">
      <div>
        <b>{fmtDayTitle(day.date, day.timezone)}</b>
        {groupName && <div className="muted">{groupName}</div>}
      </div>
      {children}
    </div>
  );
}
