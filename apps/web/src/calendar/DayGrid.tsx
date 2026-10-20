import { zonedDayRange, type CalendarBooking, type CalendarDay } from '@btx24/shared';
import { fmtTime } from '../format.js';
import { layoutResourceDay } from './layout.js';

const PX_PER_MIN = 0.8; // 48 px на час

export function DayGrid({ day, highlightDealId, onSelect }: { day: CalendarDay; highlightDealId: number | null; onSelect: (b: CalendarBooking) => void }) {
  const { start, end } = zonedDayRange(day.date, day.timezone);
  const minutes = (end.getTime() - start.getTime()) / 60_000;
  const hours = Array.from({ length: Math.round(minutes / 60) }, (_, i) => i);
  if (!day.resources.length) return <div className="empty">В модуле бронирования нет ресурсов.</div>;

  return (
    <div className="grid-scroll">
      <div className="grid" style={{ gridTemplateColumns: `56px repeat(${day.resources.length}, minmax(140px, 1fr))` }}>
        <div className="grid-corner" />
        {day.resources.map((r) => (
          <div key={r.id} className="grid-head" title={r.name}>{r.name}</div>
        ))}
        <div className="grid-times" style={{ height: minutes * PX_PER_MIN }}>
          {hours.map((h) => (
            <div key={h} className="grid-time" style={{ top: h * 60 * PX_PER_MIN }}>{String(h).padStart(2, '0')}:00</div>
          ))}
        </div>
        {day.resources.map((r) => (
          <div key={r.id} className="grid-col" style={{ height: minutes * PX_PER_MIN, backgroundSize: `100% ${60 * PX_PER_MIN}px` }}>
            {layoutResourceDay(day.bookings, r.id, start.getTime(), end.getTime()).map((p) => (
              <button
                key={p.booking.id}
                className={`booking${p.booking.dealId && p.booking.dealId === highlightDealId ? ' highlight' : ''}${p.continuesBefore ? ' cont-before' : ''}${p.continuesAfter ? ' cont-after' : ''}`}
                style={{ top: p.top * PX_PER_MIN, height: Math.max(p.height * PX_PER_MIN - 2, 22), left: `calc(${(p.lane / p.lanes) * 100}% + 3px)`, width: `calc(${100 / p.lanes}% - 6px)` }}
                onClick={() => onSelect(p.booking)}
              >
                <strong>{p.booking.deal?.title || p.booking.name || 'Бронь'}</strong>
                <small>{fmtTime(p.booking.start, day.timezone)}–{fmtTime(p.booking.end, day.timezone)}</small>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
