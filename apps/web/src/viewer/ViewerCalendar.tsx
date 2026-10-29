import { formatDuration, paymentState, zonedDayRange, type ViewerBookingDto, type ViewerDayDto } from '@btx24/shared';
import { fmtMoney } from '../format.js';
import { lastPaymentText, timeRange } from './BookingDetails.js';
import { blockSize, gridHours, minutesOf } from './viewer-model.js';

const HOUR_PX = 56;

/**
 * Режим «Календарь»: колонки — ресурсы, строки — часы. Высота блока — длительность брони; чем
 * ниже блок, тем меньше строк внутри (название и время видны всегда). Нажатие — полный просмотр.
 */
export function ViewerCalendar({ day, onOpen }: { day: ViewerDayDto; onOpen: (b: ViewerBookingDto) => void }) {
  if (!day.resources.length) return <p className="vw-empty">Нет доступных ресурсов для отображения</p>;
  const tz = day.timezone;
  const { from, to } = gridHours(day);
  const dayStart = zonedDayRange(day.date, tz).start.getTime();
  const top = dayStart + from * 3_600_000;
  const bottom = dayStart + to * 3_600_000;
  const y = (ms: number) => ((Math.min(Math.max(ms, top), bottom) - top) / 3_600_000) * HOUR_PX;
  const hours = Array.from({ length: to - from }, (_, i) => from + i);
  const now = Date.now();
  return (
    <div className="vw-cal" style={{ ['--cols' as string]: day.resources.length }}>
      <div className="vw-cal-grid">
        <div className="vw-cal-corner" />
        {day.resources.map((r) => (
          <div key={r.id} className="vw-cal-head" title={r.name}>
            {r.name}
          </div>
        ))}
        <div className="vw-cal-times" style={{ height: (to - from) * HOUR_PX }}>
          {hours.map((h) => (
            <span key={h} style={{ top: (h - from) * HOUR_PX }}>
              {String(h).padStart(2, '0')}:00
            </span>
          ))}
        </div>
        {day.resources.map((r) => (
          <div key={r.id} className="vw-cal-col" style={{ height: (to - from) * HOUR_PX }}>
            {hours.map((h) => (
              <i key={h} className="vw-cal-line" style={{ top: (h - from) * HOUR_PX }} />
            ))}
            {now > top && now < bottom && <i className="vw-cal-now" style={{ top: y(now) }} />}
            {day.techWindows
              .filter((t) => t.resourceId === r.id)
              .map((t) => (
                <div key={t.startsAt} className="vw-cal-tech" style={{ top: y(Date.parse(t.startsAt)), height: Math.max(4, y(Date.parse(t.endsAt)) - y(Date.parse(t.startsAt))) }} title="Тех. окно">
                  <span>Тех. окно</span>
                </div>
              ))}
            {day.bookings
              .filter((b) => b.resourceIds.includes(r.id))
              .map((b) => {
                const t0 = y(Date.parse(b.startsAt));
                const h = Math.max(22, y(Date.parse(b.endsAt)) - t0);
                const size = blockSize(h);
                const p = paymentState(b.amount, b.paid);
                const last = lastPaymentText(b, tz);
                return (
                  <button key={b.bookingId} type="button" className={`vw-block s-${size}`} style={{ top: t0, height: h }} onClick={() => onOpen(b)} title={`${b.title}, ${timeRange(b, tz)}`}>
                    <span className="vw-block-title">
                      {b.important && <span className="vw-flag" aria-label="Есть важное примечание" />}
                      {b.title}
                    </span>
                    <span className="vw-block-time">{timeRange(b, tz)}</span>
                    {size !== 'sm' && (
                      <>
                        <span>{b.clientName ?? 'Клиент не указан'}</span>
                        {(b.guests !== null || b.programGuests !== null) && (
                          <span>
                            {b.guests !== null && <>👥 {b.guests}</>}
                            {b.programGuests !== null && <span className="vw-program"> · Программа: {b.programGuests}</span>}
                          </span>
                        )}
                        {(b.amount !== null || b.paid !== null) && (
                          <span>
                            {b.amount !== null ? fmtMoney(b.amount, b.currency) : '—'}
                            {b.paid !== null && <span className="vw-paid"> / {fmtMoney(b.paid, b.currency)}</span>}
                          </span>
                        )}
                      </>
                    )}
                    {size === 'lg' && (
                      <>
                        {p.debt !== null && p.debt > 0 && <span className="vw-debt">Долг: {fmtMoney(p.debt, b.currency)}</span>}
                        {last && <span className="vw-paid">+ {last}</span>}
                        <span className="muted">{formatDuration(minutesOf(b))}</span>
                        {b.important && <span className="vw-important-line">⚠ Важное примечание</span>}
                      </>
                    )}
                  </button>
                );
              })}
          </div>
        ))}
      </div>
    </div>
  );
}
