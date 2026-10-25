import { ColorLegend, type LegendItem } from '../ColorLegend.js';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { zonedDayRange, type CalendarBooking, type CalendarDay } from '@btx24/shared';
import { fmtDateTime, fmtTime } from '../format.js';
import { layoutResourceDay, slotAt } from './layout.js';

const PX_PER_MIN = 0.9; // 54 px на час, как в прототипе

/** Вид «Календарь»: колонки ресурсов, шкала суток, брони и тех. окна. */
export function DayGrid({
  day,
  highlightDealId,
  onSelect,
  onCreate,
  onStop,
}: {
  day: CalendarDay;
  highlightDealId: number | null;
  onSelect: (b: CalendarBooking) => void;
  /** Клик по пустому месту колонки — новая бронь ресурса с этого получаса (нет права — не передаётся). */
  onCreate?: (resourceId: number, start: string) => void;
  /** 🛑 у ресурса — окно стопа (нет права — не передаётся). */
  onStop?: (resourceId: number) => void;
}) {
  const { start, end } = zonedDayRange(day.date, day.timezone);
  const dayStart = start.getTime();
  const dayEnd = end.getTime();
  const minutes = (dayEnd - dayStart) / 60_000;
  const hours = Array.from({ length: Math.round(minutes / 60) }, (_, i) => i);
  const mine = useRef<HTMLButtonElement | null>(null);
  // Получас под курсором — подсказка «+ 14:30», куда встанет новая бронь.
  const [hover, setHover] = useState<{ resourceId: number; minute: number } | null>(null);
  const hasMine = !!highlightDealId && day.bookings.some((b) => b.dealId === highlightDealId);
  // Бронь сделки — в поле зрения (сетка суток длинная).
  useEffect(() => {
    mine.current?.scrollIntoView({ block: 'center', inline: 'center' });
  }, [day, highlightDealId]);
  const minuteAt = (e: MouseEvent<HTMLDivElement>) =>
    slotAt((e.clientY - e.currentTarget.getBoundingClientRect().top) / PX_PER_MIN, minutes);
  const slotIso = (minute: number) => new Date(dayStart + minute * 60_000).toISOString();
  if (!day.resources.length)
    return <div className="empty">В выбранной группе нет ресурсов. Откройте ⚙ и добавьте ресурсы в группу.</div>;

  const legend: LegendItem[] = [
    { label: 'Бронь', swatch: { background: 'linear-gradient(145deg, rgba(0, 122, 255, 0.95), rgba(88, 86, 214, 0.9))' } },
    { label: 'Тех. окно', swatch: { background: 'linear-gradient(145deg, rgba(255, 177, 59, 0.92), rgba(248, 154, 29, 0.86))' }, title: 'Можно бронировать — с предупреждением' },
    { label: 'Стоп ресурса', swatch: { borderColor: 'rgba(217, 45, 32, 0.45)', background: 'rgba(217, 45, 32, 0.12)' }, title: 'Ресурс закрыт для бронирования' },
    ...(day.bookings.some((b) => b.missing) ? [{ label: 'Удалена в Битрикс24', swatch: { background: '#9ca3af' } }] : []),
    ...(hasMine ? [{ label: 'Эта сделка', swatch: { borderColor: '#16a34a', background: 'rgba(0, 122, 255, 0.9)' } }] : []),
  ];
  return (
    <>
    <ColorLegend items={legend} label="Обозначения календаря" className="block" />
    <div className={`grid-scroll${hasMine ? ' has-highlight' : ''}`}>
      <div className="grid" style={{ gridTemplateColumns: `56px repeat(${day.resources.length}, minmax(170px, 1fr))` }}>
        <div className="grid-corner" />
        {day.resources.map((r) => (
          <div key={r.id} className={`grid-head${(day.stops ?? []).some((s) => s.resourceId === r.id) ? ' stopped' : ''}`} title={r.name}>
            <span className="grid-head-name">
              {r.name}
              <small className="muted">#{r.id}</small>
            </span>
            {onStop && (
              <button type="button" className="stop-btn" title={`Стоп ресурса «${r.name}»: закрыть для бронирования`} aria-label={`Стоп ресурса «${r.name}»`} onClick={() => onStop(r.id)}>
                <StopSign />
              </button>
            )}
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
            className={`grid-col${onCreate ? ' creatable' : ''}`}
            style={{ height: minutes * PX_PER_MIN, backgroundSize: `100% ${30 * PX_PER_MIN}px` }}
            onClick={onCreate && ((e) => onCreate(r.id, slotIso(minuteAt(e))))}
            onMouseMove={onCreate && ((e) => setHover({ resourceId: r.id, minute: minuteAt(e) }))}
            onMouseLeave={onCreate && (() => setHover(null))}
          >
            {hover?.resourceId === r.id && (
              <div className="slot-ghost" style={{ top: hover.minute * PX_PER_MIN, height: 30 * PX_PER_MIN }} aria-hidden="true">
                + {fmtTime(slotIso(hover.minute), day.timezone)}
              </div>
            )}
            {(day.stops ?? [])
              .filter((s) => s.resourceId === r.id)
              .map((s) => {
                const top = Math.max(0, (Date.parse(s.start) - dayStart) / 60_000);
                const bottom = Math.min(minutes, (Date.parse(s.end) - dayStart) / 60_000);
                if (bottom <= top) return null;
                return (
                  <div
                    key={`s${s.id}`}
                    className="stop-block"
                    title={`Стоп ${s.from} — ${s.to}: ${s.reason} (${s.createdBy})`}
                    style={{ top: top * PX_PER_MIN, height: (bottom - top) * PX_PER_MIN }}
                    onClick={(e) => e.stopPropagation()}
                    onMouseMove={(e) => e.stopPropagation()}
                    onMouseEnter={() => setHover(null)}
                  >
                    <strong>СТОП</strong>
                    <small>{s.reason}</small>
                  </div>
                );
              })}
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
                className={`booking${p.booking.dealId && p.booking.dealId === highlightDealId ? ' highlight' : ''}${p.continuesBefore ? ' cont-before' : ''}${p.continuesAfter ? ' cont-after' : ''}${p.booking.missing ? ' missing' : ''}`}
                style={{
                  top: p.top * PX_PER_MIN,
                  height: Math.max(p.height * PX_PER_MIN - 2, 30),
                  left: `calc(${(p.lane / p.lanes) * 100}% + 4px)`,
                  width: `calc(${100 / p.lanes}% - 8px)`,
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(p.booking);
                }}
                onMouseMove={(e) => e.stopPropagation()}
                onMouseEnter={() => setHover(null)}
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
                {p.booking.missing && <MissingVeil />}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
    </>
  );
}

/** Слой поверх брони, удалённой в Битрикс24: она на месте, пока сотрудник не решит, что с ней делать. */
export function MissingVeil() {
  return (
    <span className="missing-veil" title="Бронь удалена в Битрикс24. Откройте её: оставить или удалить из приложения">
      Удалена в Битрикс24 — нужно решение
    </span>
  );
}

export const bookingTitle = (b: CalendarBooking) => b.deal?.title || b.name || 'Бронирование';

/** Знак «СТОП» (восьмиугольник). */
export function StopSign({ size = 18 }: { size?: number }) {
  return (
    <svg className="stop-sign" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7.9 2h8.2L22 7.9v8.2L16.1 22H7.9L2 16.1V7.9Z" fill="#d92d20" />
      <path d="M7 12h10" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}
