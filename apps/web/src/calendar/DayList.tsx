import type { CalendarBooking, CalendarDay, CalendarTechWindow } from '@btx24/shared';
import { fmtDateTime, fmtMoney } from '../format.js';
import { bookingTitle } from './DayGrid.js';
import { DayHeader } from './DayHeader.js';

type Entry =
  { kind: 'booking'; at: number; item: CalendarBooking } | { kind: 'tech'; at: number; item: CalendarTechWindow };

/** Вид «Список»: брони и тех. окна дня по времени — удобно на телефоне. */
export function DayList({
  day,
  groupName,
  highlightDealId,
  onSelect,
}: {
  day: CalendarDay;
  groupName: string;
  highlightDealId: number | null;
  onSelect: (b: CalendarBooking) => void;
}) {
  const names = new Map(day.resources.map((r) => [r.id, r.name]));
  if (!day.resources.length)
    return <div className="empty">В выбранной группе нет ресурсов. Откройте ⚙ и добавьте ресурсы в группу.</div>;
  const entries: Entry[] = [
    ...day.bookings.map((b) => ({ kind: 'booking' as const, at: Date.parse(b.start), item: b })),
    ...day.techWindows.map((t) => ({ kind: 'tech' as const, at: Date.parse(t.start), item: t })),
  ].sort((a, b) => a.at - b.at || (a.kind === 'booking' ? -1 : 1));
  const source = new Map(day.bookings.map((b) => [b.id, b]));

  return (
    <section className="day-panel">
      <DayHeader day={day} groupName={groupName}>
        <span className="pill">
          Броней: {day.bookings.length} · Техокон: {day.techWindows.length}
        </span>
      </DayHeader>
      {!entries.length && <div className="empty">На выбранную дату бронирований и технологических окон нет.</div>}
      <ul className={`list${highlightDealId && day.bookings.some((b) => b.dealId === highlightDealId) ? ' has-highlight' : ''}`}>
        {entries.map((e) =>
          e.kind === 'tech' ? (
            <li key={`t${e.item.bookingId}:${e.item.resourceId}`} className="list-item tech">
              <div className="list-top">
                <strong>Тех. окно</strong>
                <span className="pill tech">{names.get(e.item.resourceId) ?? `#${e.item.resourceId}`}</span>
              </div>
              <span className="list-time">
                {fmtDateTime(e.item.start, day.timezone)} — {fmtDateTime(e.item.end, day.timezone)}
              </span>
              {source.get(e.item.bookingId)?.dealId && (
                <span className="list-meta">После брони: {bookingTitle(source.get(e.item.bookingId)!)}</span>
              )}
            </li>
          ) : (
            <li key={e.item.id}>
              <button
                className={`list-item${e.item.dealId && e.item.dealId === highlightDealId ? ' highlight' : ''}`}
                onClick={() => onSelect(e.item)}
              >
                <span className="list-top">
                  <strong>{bookingTitle(e.item)}</strong>
                  {e.item.dealId && e.item.dealId === highlightDealId && <span className="mine-badge">Эта сделка</span>}
                  <span className="pill">{e.item.resourceIds.map((id) => names.get(id) ?? `#${id}`).join(', ')}</span>
                </span>
                <span className="list-time">
                  {fmtDateTime(e.item.start, day.timezone)} — {fmtDateTime(e.item.end, day.timezone)}
                  {e.item.dealId ? ` · Сделка #${e.item.dealId}` : ''}
                  {e.item.deal?.opportunity ? ` · ${fmtMoney(e.item.deal.opportunity, e.item.deal.currency)}` : ''}
                </span>
                {e.item.fields
                  .filter((f) => f.inList)
                  .map((f) => (
                    <span key={f.code} className="list-meta">
                      <b>{f.label}:</b> {f.value}
                    </span>
                  ))}
              </button>
            </li>
          ),
        )}
      </ul>
    </section>
  );
}
