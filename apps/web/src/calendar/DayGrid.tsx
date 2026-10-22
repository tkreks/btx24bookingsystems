import { useEffect, useRef } from 'react';
import { zonedDayRange, type CalendarBooking, type CalendarDay } from '@btx24/shared';
import { fmtDateTime, fmtTime } from '../format.js';
import { layoutResourceDay } from './layout.js';

const PX_PER_MIN = 0.9; // 54 px на час, как в прототипе

/** Вид «Календарь»: колонки ресурсов, шкала суток, брони и тех. окна. */
export function DayGrid({
  day,
  highlightDealId,
  onSelect,
}: {
  day: CalendarDay;
  highlightDealId: number | null;
  onSelect: (b: CalendarBooking) => void;
}) {
  const { start, end } = zonedDayRange(day.date, day.timezone);
  const dayStart = start.getTime();
  const dayEnd = end.getTime();
  const minutes = (dayEnd - dayStart) / 60_000;
  const hours = Array.from({ length: Math.round(minutes / 60) }, (_, i) => i);
  const mine = useRef<HTMLButtonElement | null>(null);
  const hasMine = !!highlightDealId && day.bookings.some((b) => b.dealId === highlightDealId);
  // Бронь сделки — в поле зрения (сетка суток длинная).
  useEffect(() => mine.current?.scrollIntoView({ block: 'center', inline: 'center' }), [day, highlightDealId]);
  if (!day.resources.length)
    return <div className="empty">В выбранной группе нет ресурсов. Откройте ⚙ и добавьте ресурсы в группу.</div>;

  return (
    <div className={`grid-scroll${hasMine ? ' has-highlight' : ''}`}>
      <div className="grid" style={{ gridTemplateColumns: `56px repeat(${day.resources.length}, minmax(170px, 1fr))` }}>
        <div className="grid-corner" />
        {day.resources.map((r) => (
          <div key={r.id} className="grid-head" title={r.name}>
            {r.name}
            <small className="muted">#{r.id}</small>
          </div>
        ))}
        <div className="grid-times" style={{ height: minutes * PX_PER_MIN }}>
          {hours.map((h) => (
            <div key={h} className="grid-time" style={{ top: h * 60 * PX_PER_MIN }}>
              {String(h).padStart(2, '0')}:00
            </div>
          ))}
        </div>
        {day.resources.map((r) => (
          <div
            key={r.id}
            className="grid-col"
            style={{ height: minutes * PX_PER_MIN, backgroundSize: `100% ${30 * PX_PER_MIN}px` }}
          >
            {day.techWindows
              .filter((t) => t.resourceId === r.id)
              .map((t) => {
                const top = Math.max(0, (Date.parse(t.start) - dayStart) / 60_000);
                const bottom = Math.min(minutes, (Date.parse(t.end) - dayStart) / 60_000);
                if (bottom <= top) return null;
                return (
                  <div
                    key={`t${t.bookingId}`}
                    className="tech-window"
                    title={`Тех. окно: ${fmtDateTime(t.start, day.timezone)} — ${fmtDateTime(t.end, day.timezone)}`}
                    style={{ top: top * PX_PER_MIN, height: Math.max((bottom - top) * PX_PER_MIN - 2, 20) }}
                  >
                    <strong>Тех. окно</strong>
                    <small>
                      {fmtTime(t.start, day.timezone)} — {fmtTime(t.end, day.timezone)}
                    </small>
                  </div>
                );
              })}
            {layoutResourceDay(day.bookings, r.id, dayStart, dayEnd).map((p) => (
              <button
                key={p.booking.id}
                ref={p.booking.dealId && p.booking.dealId === highlightDealId ? mine : undefined}
                className={`booking${p.booking.dealId && p.booking.dealId === highlightDealId ? ' highlight' : ''}${p.continuesBefore ? ' cont-before' : ''}${p.continuesAfter ? ' cont-after' : ''}`}
                style={{
                  top: p.top * PX_PER_MIN,
                  height: Math.max(p.height * PX_PER_MIN - 2, 30),
                  left: `calc(${(p.lane / p.lanes) * 100}% + 4px)`,
                  width: `calc(${100 / p.lanes}% - 8px)`,
                }}
                onClick={() => onSelect(p.booking)}
              >
                <strong>{bookingTitle(p.booking)}</strong>
                <small>
                  {fmtDateTime(p.booking.start, day.timezone)} — {fmtDateTime(p.booking.end, day.timezone)}
                </small>
                {p.booking.dealId && p.booking.dealId === highlightDealId && <span className="mine-badge">Эта сделка</span>}
                {p.booking.dealId && <small>Сделка #{p.booking.dealId}</small>}
                {p.booking.fields
                  .filter((f) => f.inList)
                  .map((f) => (
                    <small key={f.code}>
                      <b>{f.label}:</b> {f.value}
                    </small>
                  ))}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export const bookingTitle = (b: CalendarBooking) => b.deal?.title || b.name || 'Бронирование';
