import { useEffect, useRef, useState } from 'react';
import { shiftDate } from '../format.js';

const noon = (d: string) => new Date(`${d}T12:00:00Z`);
const fmt = (d: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', ...o }).format(noon(d));
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const isWeekend = (d: string) => [0, 6].includes(noon(d).getUTCDay());

/** 42 дня сетки месяца `YYYY-MM` с понедельника недели, где первое число. */
export function monthCells(month: string): string[] {
  const first = `${month}-01`;
  const start = shiftDate(first, -((noon(first).getUTCDay() + 6) % 7));
  return Array.from({ length: 42 }, (_, i) => shiftDate(start, i));
}

/** «сегодня», «завтра», «послезавтра», «вчера»; дальше — null. */
export function relativeDay(date: string, today: string): string | null {
  const diff = Math.round((noon(date).getTime() - noon(today).getTime()) / 86_400_000);
  return ({ [-1]: 'вчера', 0: 'сегодня', 1: 'завтра', 2: 'послезавтра' } as Record<number, string>)[diff] ?? null;
}

/** Месяц `YYYY-MM` со сдвигом. */
export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number);
  const t = y * 12 + (m - 1) + by;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

/**
 * Выбор даты брони (раздел «Ресурс и время»): крупная дата со стрелками, неделя вокруг неё для
 * быстрого перехода и календарь месяца по нажатию на дату. Прошедшие дни приглушены, не запрещены.
 */
export function DatePicker({ date, today, onDate, label = 'Дата' }: { date: string; today: string; onDate: (d: string) => void; label?: string }) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(date.slice(0, 7));
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc, true);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc, true);
    };
  }, [open]);
  const pick = (d: string) => {
    onDate(d);
    setOpen(false);
  };
  const toggle = () => {
    setMonth(date.slice(0, 7));
    setOpen(!open);
  };
  const rel = relativeDay(date, today);
  const week = Array.from({ length: 7 }, (_, i) => shiftDate(date, i - 3));
  const dayClass = (d: string) => `${d === date ? ' active' : ''}${d === today ? ' today' : ''}${d < today ? ' past' : ''}${isWeekend(d) ? ' weekend' : ''}`;

  return (
    <div className="dp" ref={box} role="group" aria-label={label}>
      <div className="dp-head">
        <button type="button" className="dp-arrow" aria-label="Предыдущий день" onClick={() => onDate(shiftDate(date, -1))}>
          ‹
        </button>
        <button type="button" className="dp-main" aria-haspopup="dialog" aria-expanded={open} aria-label={`${label}: ${fmt(date, { day: 'numeric', month: 'long', year: 'numeric' })}, открыть календарь`} onClick={toggle}>
          <span className="dp-num">{Number(date.slice(8, 10))}</span>
          <span className="dp-text">
            <b>{cap(fmt(date, { weekday: 'long' }))}</b>
            <small>{fmt(date, { day: 'numeric', month: 'long', year: 'numeric' }).replace(/^\d+\s/, '').replace(/\s?г\.$/, '')}</small>
          </span>
          {rel && <span className="dp-rel">{rel}</span>}
          <svg className="dp-cal-icon" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="5" width="18" height="16" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M3 10h18M8 3v4M16 3v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <button type="button" className="dp-arrow" aria-label="Следующий день" onClick={() => onDate(shiftDate(date, 1))}>
          ›
        </button>
      </div>
      <div className="dp-week" role="group" aria-label="Быстрый переход">
        {week.map((d) => (
          <button key={d} type="button" aria-pressed={d === date} className={`dp-day${dayClass(d)}`} onClick={() => onDate(d)}>
            <small>{fmt(d, { weekday: 'short' })}</small>
            <b>{Number(d.slice(8, 10))}</b>
          </button>
        ))}
      </div>
      {open && (
        <div className="dp-pop" role="dialog" aria-label="Календарь">
          <div className="dp-pop-head">
            <button type="button" className="dp-arrow" aria-label="Предыдущий месяц" onClick={() => setMonth(shiftMonth(month, -1))}>
              ‹
            </button>
            <b>{cap(fmt(`${month}-01`, { month: 'long', year: 'numeric' }).replace(/\s?г\.$/, ''))}</b>
            <button type="button" className="dp-arrow" aria-label="Следующий месяц" onClick={() => setMonth(shiftMonth(month, 1))}>
              ›
            </button>
          </div>
          <div className="dp-grid">
            {['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((w) => (
              <span key={w} className="dp-wd">
                {w}
              </span>
            ))}
            {monthCells(month).map((d) => (
              <button key={d} type="button" aria-pressed={d === date} aria-label={fmt(d, { day: 'numeric', month: 'long' })} className={`dp-cell${dayClass(d)}${d.slice(0, 7) !== month ? ' other' : ''}`} onClick={() => pick(d)}>
                {Number(d.slice(8, 10))}
              </button>
            ))}
          </div>
          <div className="dp-pop-foot">
            <button type="button" className="link" onClick={() => pick(today)}>
              Сегодня
            </button>
            <button type="button" className="link" onClick={() => pick(shiftDate(today, 1))}>
              Завтра
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
