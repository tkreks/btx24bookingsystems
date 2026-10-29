import { useState } from 'react';
import { formatDuration, type ViewerBookingDto, type ViewerDayDto } from '@btx24/shared';
import { fmtTime } from '../format.js';
import { availability, type ResourceAvailability } from './viewer-model.js';

const NEEDS = [60, 120, 180, 240, 0] as const;
const needLabel = (m: number) => (m ? formatDuration(m) : 'Любая');
const longDate = (date: string, tz: string) => new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${date}T12:00:00Z`));

function span(start: number, end: number, tz: string): string {
  const e = new Date(end).toISOString();
  const endText = fmtTime(e, tz) === '00:00' ? '24:00' : fmtTime(e, tz);
  return `${fmtTime(new Date(start).toISOString(), tz)}–${endText}`;
}

/** Цветная шкала суток: зелёный — свободно, красный — занято, оранжевый — тех. окно. */
function Bar({ a, need, tz, onOpen }: { a: ResourceAvailability; need: number; tz: string; onOpen?: (b: ViewerBookingDto) => void }) {
  const total = a.to - a.from;
  return (
    <div className="vw-bar-wrap">
      <div className="vw-bar" role="img" aria-label="Шкала занятости с 00:00 до 24:00">
        {a.pieces.map((p, i) => {
          const fits = p.kind !== 'free' || !need || a.free.some((f) => f.start <= p.start && f.end >= p.end && f.end - f.start >= need * 60_000);
          const style = { left: `${((p.start - a.from) / total) * 100}%`, width: `${((p.end - p.start) / total) * 100}%` };
          const title = `${p.kind === 'busy' ? 'Занято' : p.kind === 'tech' ? 'Тех. окно' : 'Свободно'} ${span(p.start, p.end, tz)}${p.booking ? ` — ${p.booking.title}` : ''}`;
          return p.kind === 'busy' && onOpen && p.booking ? (
            <button key={i} type="button" className="vw-piece busy" style={style} title={title} aria-label={title} onClick={() => onOpen(p.booking!)} />
          ) : (
            <span key={i} className={`vw-piece ${p.kind}${fits ? '' : ' unfit'}`} style={style} title={title} />
          );
        })}
      </div>
      <div className="vw-axis" aria-hidden="true">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>24</span>
      </div>
    </div>
  );
}

function FreeList({ a, need, tz }: { a: ResourceAvailability; need: number; tz: string }) {
  if (!a.free.length) return <p className="vw-empty small">На выбранную дату свободных интервалов нет</p>;
  return (
    <ul className="vw-free">
      {a.free.map((f) => {
        const fits = !need || f.end - f.start >= need * 60_000;
        return (
          <li key={f.start} className={fits ? '' : 'unfit'}>
            <span className="vw-dot free" aria-hidden="true" /> {span(f.start, f.end, tz)} — {formatDuration((f.end - f.start) / 60_000)}
            {!fits && <span className="muted"> · не подходит</span>}
          </li>
        );
      })}
    </ul>
  );
}

function statusOf(a: ResourceAvailability): { cls: string; text: string } {
  if (!a.free.length) return { cls: 'busy', text: 'Свободного времени нет' };
  if (a.freeNow === true) return { cls: 'free', text: 'Сейчас свободно' };
  if (a.freeNow === false) return { cls: 'busy', text: 'Сейчас занято · есть свободные интервалы' };
  return { cls: 'free', text: 'Есть свободные интервалы' };
}

/** Режим «Доступность»: карточка на ресурс, по нажатию — итоги, свободное и занятое время. */
export function ViewerAvailability({ day, onOpen }: { day: ViewerDayDto; onOpen: (b: ViewerBookingDto) => void }) {
  const [need, setNeed] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  if (!day.resources.length) return <p className="vw-empty">Нет доступных ресурсов для отображения</p>;
  const tz = day.timezone;
  return (
    <>
      <div className="vw-need" role="group" aria-label="Нужная продолжительность">
        {NEEDS.map((m) => (
          <button key={m} type="button" className={need === m ? 'active' : ''} onClick={() => setNeed(m)}>
            {needLabel(m)}
          </button>
        ))}
      </div>
      <p className="vw-legend">
        <span className="vw-dot free" /> свободно <span className="vw-dot busy" /> занято <span className="vw-dot tech" /> тех. окно
      </p>
      <ul className="vw-avail">
        {day.resources.map((r) => {
          const a = availability(day, r.id);
          const st = statusOf(a);
          const expanded = open === r.id;
          const fitting = need ? a.free.filter((f) => f.end - f.start >= need * 60_000).length : a.free.length;
          return (
            <li key={r.id} className={`vw-card${expanded ? ' open' : ''}`}>
              <div className="vw-avail-head">
                <div>
                  <span className="vw-title">{a.name}</span>
                  <span className="muted">
                    {longDate(day.date, tz)} · Рабочее время: 00:00–24:00
                  </span>
                </div>
                <span className={`vw-avail-status ${st.cls}`}>{st.text}</span>
              </div>
              <Bar a={a} need={need} tz={tz} onOpen={onOpen} />
              <div className="vw-avail-sum">
                <span>
                  Свободно: <b>{formatDuration(a.freeMinutes)}</b>
                </span>
                <span>
                  Занято: <b>{formatDuration(a.busyMinutes)}</b>
                </span>
                <span>
                  Загрузка: <b>{a.load}%</b>
                </span>
                <span>
                  Бронирований: <b>{a.bookings.length}</b>
                </span>
              </div>
              {need > 0 && <p className={fitting ? 'vw-fit' : 'vw-debt'}>{fitting ? `Подходящих окон на ${needLabel(need)}: ${fitting}` : `Нет окна на ${needLabel(need)}`}</p>}
              <FreeList a={a} need={need} tz={tz} />
              {a.free.length > 0 && (
                <p>
                  Самое длинное окно: <b>{formatDuration(a.longestFree)}</b>
                </p>
              )}
              <button type="button" className="vw-more" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : r.id)}>
                {expanded ? 'Свернуть ⌃' : 'Подробнее ⌄'}
              </button>
              {expanded && (
                <div className="vw-details">
                  <section className="vw-sec">
                    <h3>Ресурс</h3>
                    <div className="vw-row">
                      <span>ID ресурса</span>
                      <b>{r.id}</b>
                    </div>
                    <div className="vw-row">
                      <span>Свободных интервалов</span>
                      <b>{a.free.length}</b>
                    </div>
                  </section>
                  <section className="vw-sec">
                    <h3>Занятое время</h3>
                    {!a.bookings.length && <p className="muted">Бронирований нет</p>}
                    <ul className="vw-busy">
                      {a.pieces
                        .filter((p) => p.kind === 'busy' && p.booking)
                        .map((p) => (
                          <li key={p.booking!.bookingId}>
                            <b>
                              {span(p.start, p.end, tz)} · {formatDuration((p.end - p.start) / 60_000)}
                            </b>
                            <span>{p.booking!.title}</span>
                            <span>Клиент: {p.booking!.clientName ?? 'Не указан'}</span>
                            {p.booking!.guests !== null && <span>Гостей: {p.booking!.guests}</span>}
                            {p.booking!.important && <span className="vw-important-line">⚠ Есть важное примечание</span>}
                            <button type="button" className="link" onClick={() => onOpen(p.booking!)}>
                              Открыть бронирование ›
                            </button>
                          </li>
                        ))}
                    </ul>
                  </section>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
