import { zonedDayRange, type CalendarBooking, type CalendarDay } from '@btx24/shared';
import { fmtDateTime, fmtTime } from '../format.js';
import { DayHeader } from './DayHeader.js';
import { availabilityPieces, slotAt } from './layout.js';

/** Вид «Доступность»: карточка на ресурс со шкалой суток (свободно / бронь / тех. окно). */
export function DayAvailability({
  day,
  groupName,
  highlightDealId = null,
  onSelect,
  onCreate,
}: {
  day: CalendarDay;
  groupName: string;
  highlightDealId?: number | null;
  onSelect: (b: CalendarBooking) => void;
  /** Клик по свободному куску или тех. окну — новая бронь ресурса с этого места шкалы. */
  onCreate?: (resourceId: number, start: string) => void;
}) {
  const { start, end } = zonedDayRange(day.date, day.timezone);
  const dayMinutes = (end.getTime() - start.getTime()) / 60_000;
  const byId = new Map(day.bookings.map((b) => [b.id, b]));
  if (!day.resources.length)
    return <div className="empty">В выбранной группе нет ресурсов. Откройте ⚙ и добавьте ресурсы в группу.</div>;
  return (
    <section className="day-panel">
      <DayHeader day={day} groupName={groupName}>
        <div className="availability-legend">
          <span>
            <i className="dot free" />
            Свободно
          </span>
          <span>
            <i className="dot booked" />
            Бронь
          </span>
          <span>
            <i className="dot tech" />
            Тех. окно
          </span>
        </div>
      </DayHeader>
      <div className="availability-grid">
        {day.resources.map((r) => {
          const pieces = availabilityPieces(day.bookings, day.techWindows, r.id, start.getTime(), end.getTime());
          const booked = day.bookings.filter((b) => b.resourceIds.includes(r.id)).length;
          const tech = day.techWindows.filter((t) => t.resourceId === r.id).length;
          const summary =
            !booked && !tech
              ? 'Свободно весь день'
              : [booked ? `Броней: ${booked}` : '', tech ? `Техокон: ${tech}` : ''].filter(Boolean).join(' · ');
          return (
            <article key={r.id} className="availability-card" aria-label={`${r.name} #${r.id}`}>
              <header>
                <h2>{r.name}</h2>
                <div className="muted">#{r.id}</div>
              </header>
              <div className={`availability-summary ${tech ? 'mixed' : booked ? 'busy' : ''}`}>{summary}</div>
              <div className="availability-bar" role="group" aria-label="Шкала занятости с 00:00 до 24:00">
                {pieces.map((p, i) => {
                  const style = { left: `${p.from * 100}%`, width: `${(p.to - p.from) * 100}%` };
                  // Подпись — только если кусок не уже ~2 часов, иначе она обрезается до «ех».
                  const roomy = p.to - p.from >= 0.08;
                  const booking = p.kind === 'booked' && p.bookingId !== null ? byId.get(p.bookingId) : undefined;
                  if (booking)
                    return (
                      <button
                        key={i}
                        className={`piece booked${booking.dealId && booking.dealId === highlightDealId ? ' highlight' : ''}`}
                        style={style}
                        title={`${fmtDateTime(booking.start, day.timezone)} → ${fmtDateTime(booking.end, day.timezone)}`}
                        aria-label={`Бронь ${fmtDateTime(booking.start, day.timezone)} — ${fmtDateTime(booking.end, day.timezone)}`}
                        onClick={() => onSelect(booking)}
                      >
                        {roomy && (
                          <span>
                            {fmtTime(booking.start, day.timezone)}
                            <small>→ {fmtTime(booking.end, day.timezone)}</small>
                          </span>
                        )}
                      </button>
                    );
                  const techTitle =
                    p.kind === 'tech' && p.start && p.end
                      ? `Тех. окно ${fmtTime(p.start, day.timezone)}–${fmtTime(p.end, day.timezone)}`
                      : undefined;
                  const techLabel = p.kind === 'tech' && roomy && p.start && p.end && (
                    <span>
                      Тех.
                      <small>
                        {fmtTime(p.start, day.timezone)}–{fmtTime(p.end, day.timezone)}
                      </small>
                    </span>
                  );
                  if (onCreate && p.kind !== 'booked')
                    return (
                      <button
                        key={i}
                        className={`piece ${p.kind} addable`}
                        style={style}
                        title={techTitle ? `${techTitle} · нажмите, чтобы забронировать` : 'Нажмите, чтобы забронировать'}
                        aria-label={`Забронировать ${r.name}`}
                        onClick={(e) => {
                          // Место клика на шкале → получас, но не раньше начала куска.
                          const bar = e.currentTarget.parentElement!.getBoundingClientRect();
                          const minute = slotAt(((e.clientX - bar.left) / bar.width) * dayMinutes, dayMinutes, p.from * dayMinutes);
                          onCreate(r.id, new Date(start.getTime() + minute * 60_000).toISOString());
                        }}
                      >
                        {techLabel}
                      </button>
                    );
                  return (
                    <div key={i} className={`piece ${p.kind}`} style={style} title={techTitle}>
                      {techLabel}
                    </div>
                  );
                })}
              </div>
              <div className="availability-axis" aria-hidden="true">
                <span>00</span>
                <span>06</span>
                <span>12</span>
                <span>18</span>
                <span>24</span>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
