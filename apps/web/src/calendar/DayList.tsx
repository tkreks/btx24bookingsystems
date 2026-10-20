import type { CalendarBooking, CalendarDay } from '@btx24/shared';
import { fmtDateTime, fmtMoney } from '../format.js';

export function DayList({ day, highlightDealId, onSelect }: { day: CalendarDay; highlightDealId: number | null; onSelect: (b: CalendarBooking) => void }) {
  const names = new Map(day.resources.map((r) => [r.id, r.name]));
  if (!day.bookings.length) return <div className="empty">На эту дату броней нет.</div>;
  return (
    <ul className="list">
      {day.bookings.map((b) => (
        <li key={b.id}>
          <button className={`list-item${b.dealId && b.dealId === highlightDealId ? ' highlight' : ''}`} onClick={() => onSelect(b)}>
            <span className="list-time">{fmtDateTime(b.start, day.timezone)} — {fmtDateTime(b.end, day.timezone)}</span>
            <strong>{b.deal?.title || b.name || 'Бронь'}</strong>
            <span className="list-meta">
              {b.resourceIds.map((id) => names.get(id) ?? `#${id}`).join(', ')}
              {b.deal?.opportunity ? ` · ${fmtMoney(b.deal.opportunity, b.deal.currency)}` : ''}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
