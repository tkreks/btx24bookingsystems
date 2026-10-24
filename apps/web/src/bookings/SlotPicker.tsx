import { ColorLegend, type LegendItem } from '../ColorLegend.js';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import {
  zonedDayRange,
  zonedTimeToUtc,
  type CalendarBooking,
  type CalendarDay,
  type CalendarTechWindow,
  type MyGroupDto,
  type ResourceStopDto,
} from '@btx24/shared';
import { availabilityPieces, slotAt } from '../calendar/layout.js';
import { fmtDayTitle, fmtTime, shiftDate } from '../format.js';
import { defaultPeriod, periodToUtc, type PeriodFields } from './booking-form.js';

/** Занятость ресурса на выбранное время: свободен, тех. окно (можно), пересечение с бронью или стоп ресурса. */
export type SlotState = { kind: 'free' } | { kind: 'tech' } | { kind: 'busy'; bookings: CalendarBooking[] } | { kind: 'stop'; stop: ResourceStopDto };

export function slotStateOf(
  rid: number,
  bookings: CalendarBooking[],
  techWindows: CalendarTechWindow[],
  startMs: number,
  endMs: number,
  stops: ResourceStopDto[] = [],
): SlotState {
  const stop = stops.find((s) => s.resourceId === rid && Date.parse(s.start) < endMs && Date.parse(s.end) > startMs);
  if (stop) return { kind: 'stop', stop };
  const hit = bookings.filter((b) => b.resourceIds.includes(rid) && Date.parse(b.start) < endMs && Date.parse(b.end) > startMs);
  if (hit.length) return { kind: 'busy', bookings: hit };
  if (techWindows.some((t) => t.resourceId === rid && Date.parse(t.start) < endMs && Date.parse(t.end) > startMs)) return { kind: 'tech' };
  return { kind: 'free' };
}

/** Текущее время, раз в минуту (проверка «бронь в прошлом» без Date.now() при отрисовке). */
export function useNow(stepMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), stepMs);
    return () => clearInterval(t);
  }, [stepMs]);
  return now;
}

/** Начало брони прошло (запас 5 минут на заполнение формы). */
export const isPastStart = (startMs: number, now: number) => startMs < now - 5 * 60_000;

const DURATIONS_H = [2, 3, 4, 6];
const NIGHTS = [1, 2, 3, 5, 7];

/**
 * Шаг мастера «Дата и ресурс» (вместо таблицы «ресурсы × часы» с прокруткой во все стороны):
 * сверху — день и время (длительность или заезд/ночи), ниже — список ресурсов сверху вниз со
 * статусом на это время и шкалой занятости. Клик по шкале — время с этого места (почасовые группы).
 */
/** Цвета таймлайна ресурса: занято, тех. окно, выбранное время. */
const SLOT_LEGEND: LegendItem[] = [
  { label: 'Занято', swatch: { background: '#93c5fd' } },
  { label: 'Тех. окно — можно', swatch: { background: '#fcd34d' }, title: 'Пересечение с тех. окном разрешено, с предупреждением' },
  { label: 'Выбранное время', swatch: { borderColor: 'var(--primary)', background: 'rgba(0, 122, 255, 0.18)' } },
];

export function SlotPicker({
  compact = false,
  group,
  timezone,
  period,
  onPeriod,
  days,
  loading = false,
  resourceIds,
  onResources,
}: {
  compact?: boolean;
  group: MyGroupDto;
  timezone: string;
  period: PeriodFields;
  onPeriod: (p: PeriodFields) => void;
  /** Дни брони (с первого по последний) — занятость ресурсов на всё время брони; null — загрузка. */
  days: CalendarDay | null;
  /** Занятость на выбранные дни ещё не пришла: `days` — прежние, под загрузчиком. */
  loading?: boolean;
  resourceIds: number[];
  onResources: (ids: number[]) => void;
}) {
  const [onlyFree, setOnlyFree] = useState(false);
  const [draft, setDraft] = useState<{ rid: number; period: PeriodFields } | null>(null);
  const now = useNow();
  const interval = group.bookingMode === 'interval';
  const startMs = zonedTimeToUtc(period.startDate, period.startTime || '00:00', timezone).getTime();
  const endMs = zonedTimeToUtc(period.endDate, period.endTime || '00:00', timezone).getTime();
  const durationMs = endMs - startMs;
  const nights = Math.round((Date.parse(period.endDate) - Date.parse(period.startDate)) / 86_400_000);
  // Во встройке — сутки выбранного дня; вне неё «заезд/выезд» охватывает весь период.
  const range = { from: zonedDayRange(period.startDate, timezone).start.getTime(), to: zonedDayRange(interval && !compact ? period.endDate : period.startDate, timezone).end.getTime() };
  const span = range.to - range.from;
  const frac = (ms: number) => Math.min(1, Math.max(0, (ms - range.from) / span));

  const setDay = (d: string) => onPeriod(defaultPeriod(group, d, period.startTime));
  /** Новое начало, длительность прежняя. */
  const setStart = (date: string, time: string) => {
    const s = zonedTimeToUtc(date, time, timezone).getTime();
    const e = new Date(s + (durationMs > 0 ? durationMs : group.durationMinutes * 60_000));
    onPeriod({ startDate: date, startTime: time, endDate: new Intl.DateTimeFormat('sv-SE', { timeZone: timezone }).format(e), endTime: fmtTime(e.toISOString(), timezone) });
  };
  const setHours = (h: number) => {
    const e = new Date(startMs + h * 3_600_000);
    onPeriod({ ...period, endDate: new Intl.DateTimeFormat('sv-SE', { timeZone: timezone }).format(e), endTime: fmtTime(e.toISOString(), timezone) });
  };
  const shiftStart = (min: number) => {
    const s = new Date(startMs + min * 60_000);
    setStart(new Intl.DateTimeFormat('sv-SE', { timeZone: timezone }).format(s), fmtTime(s.toISOString(), timezone));
  };
  const pickOnBar = (rid: number, e: MouseEvent<HTMLDivElement>) => {
    if (interval && !compact) return onResources([rid]);
    const r = e.currentTarget.getBoundingClientRect();
    const dayMin = span / 60_000;
    const m = slotAt(((e.clientX - r.left) / r.width) * dayMin, dayMin);
    const start = new Date(range.from + m * 60_000);
    const end = new Date(start.getTime() + (durationMs > 0 ? durationMs : group.durationMinutes * 60_000));
    const localDay = (d: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: timezone }).format(d);
    const next = { startDate: localDay(start), startTime: fmtTime(start.toISOString(), timezone), endDate: localDay(end), endTime: fmtTime(end.toISOString(), timezone) };
    if (compact) setDraft({ rid, period: next });
    else {
      onPeriod(next);
      onResources([rid]);
    }
  };

  const strip = Array.from({ length: 7 }, (_, i) => shiftDate(period.startDate, i - 2));
  const resources = days?.resources ?? [];
  const rows = resources.map((r) => ({ r, state: slotStateOf(r.id, days?.bookings ?? [], days?.techWindows ?? [], startMs, endMs, days?.stops ?? []) }));
  const open = (s: SlotState) => s.kind !== 'busy' && s.kind !== 'stop';
  const free = rows.filter((x) => open(x.state)).length;
  const shown = onlyFree ? rows.filter((x) => open(x.state) || resourceIds.includes(x.r.id)) : rows;
  // Метки считаются по местному времени портала, включая дни перехода на летнее время.
  const ticks = interval && !compact
    ? Array.from({ length: nights + 1 }, (_, i) => ({ at: (i + 0.5) / (nights + 1), label: `${shiftDate(period.startDate, i).slice(8, 10)}.${shiftDate(period.startDate, i).slice(5, 7)}` }))
    : [0, 4, 8, 12, 16, 20].map((h) => ({
      at: frac(zonedTimeToUtc(period.startDate, `${String(h).padStart(2, '0')}:00`, timezone).getTime()),
      label: `${h}ч`,
    }));

  return (
    <section className="bk-section wz-slot">
      <div className="wz-daynav">
        <button type="button" aria-label="Раньше" onClick={() => setDay(shiftDate(period.startDate, -1))}>
          ‹
        </button>
        <div className="wz-days" role="group" aria-label="Дни">
          {strip.map((d) => {
            const noon = new Date(`${d}T12:00:00Z`);
            const weekend = [0, 6].includes(noon.getUTCDay());
            return (
              <button key={d} type="button" aria-pressed={d === period.startDate} className={`wz-day${d === period.startDate ? ' active' : ''}${weekend ? ' weekend' : ''}`} onClick={() => setDay(d)}>
                <small>{new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', weekday: 'short' }).format(noon)}</small>
                <b>{Number(d.slice(8, 10))}</b>
              </button>
            );
          })}
        </div>
        <button type="button" aria-label="Позже" onClick={() => setDay(shiftDate(period.startDate, 1))}>
          ›
        </button>
        <label className="wz-date-jump">
          <span>Быстрый переход к дате</span>
          <input type="date" aria-label="Дата брони" value={period.startDate} onChange={(e) => e.target.value && setDay(e.target.value)} />
        </label>
      </div>

      {!compact && <div className="wz-when">
        {interval ? (
          <>
            <label className="wz-when-field">
              <span className="df-label">Заезд {fmtDayTitle(period.startDate, timezone)}</span>
              <input type="time" aria-label="Время заезда" value={period.startTime} onChange={(e) => onPeriod({ ...period, startTime: e.target.value })} />
            </label>
            <div className="wz-when-field">
              <span className="df-label">Ночей</span>
              <div className="wz-durations" role="group" aria-label="Ночей">
                {NIGHTS.map((n) => (
                  <button key={n} type="button" aria-pressed={nights === n} className={nights === n ? 'active' : ''} onClick={() => onPeriod({ ...period, endDate: shiftDate(period.startDate, n) })}>
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <label className="wz-when-field">
              <span className="df-label">Выезд</span>
              <span className="bk-dt">
                <input type="date" aria-label="Дата выезда" value={period.endDate} onChange={(e) => e.target.value && onPeriod({ ...period, endDate: e.target.value })} />
                <input type="time" aria-label="Время выезда" value={period.endTime} onChange={(e) => onPeriod({ ...period, endTime: e.target.value })} />
              </span>
            </label>
          </>
        ) : (
          <>
            <div className="wz-when-field">
              <span className="df-label">Начало · {fmtDayTitle(period.startDate, timezone)}</span>
              <span className="wz-start">
                <button type="button" aria-label="На 30 минут раньше" onClick={() => shiftStart(-30)}>
                  −30
                </button>
                <input type="time" step={1800} aria-label="Время начала" value={period.startTime} onChange={(e) => e.target.value && setStart(period.startDate, e.target.value)} />
                <button type="button" aria-label="На 30 минут позже" onClick={() => shiftStart(30)}>
                  +30
                </button>
              </span>
            </div>
            <div className="wz-when-field">
              <span className="df-label">Длительность</span>
              <div className="wz-durations" role="group" aria-label="Длительность">
                {DURATIONS_H.map((h) => (
                  <button key={h} type="button" aria-pressed={durationMs === h * 3_600_000} className={durationMs === h * 3_600_000 ? 'active' : ''} onClick={() => setHours(h)}>
                    {h} ч
                  </button>
                ))}
              </div>
            </div>
            <label className="wz-when-field">
              <span className="df-label">Конец</span>
              <input type="time" aria-label="Время конца" value={period.endTime} onChange={(e) => onPeriod({ ...period, endTime: e.target.value })} />
            </label>
          </>
        )}
      </div>}
      {compact && <p className="muted">Нажмите на таймлайн ресурса, чтобы выбрать начало и завершение брони.</p>}

      {isPastStart(startMs, now) && (
        <p className="wz-slot-state busy" role="alert">
          Начало брони уже прошло — выберите время позже или другой день.
        </p>
      )}
      <div className="wz-res-bar-head">
        <span className="muted">{days && !loading ? `Свободно ${free} из ${resources.length} на это время` : 'Загрузка занятости…'}</span>
        <label className="wz-only-free">
          <input type="checkbox" checked={onlyFree} onChange={(e) => setOnlyFree(e.target.checked)} />
          Только свободные
        </label>
      </div>
      <ColorLegend items={SLOT_LEGEND} label="Обозначения таймлайна" className="block" />
      <div className="wz-res-wrap" aria-busy={loading || !days}>
      {(loading || !days) && (
        <div className="cal-loader" role="status">
          <span className="cal-loader-box">
            <span className="spinner" aria-hidden="true" />
            Загрузка занятости…
          </span>
        </div>
      )}
      <ul className="wz-res-list" aria-label="Ресурсы">
        {shown.map(({ r, state }) => {
          const on = resourceIds.includes(r.id);
          const pieces = availabilityPieces(days?.bookings ?? [], days?.techWindows ?? [], r.id, range.from, range.to).filter((p) => p.kind !== 'free');
          const note =
            state.kind === 'stop'
              ? `стоп: ${state.stop.reason}`
              : state.kind === 'busy'
              ? `занят ${state.bookings.map((b) => `${fmtTime(b.start, timezone)}–${fmtTime(b.end, timezone)}`).join(', ')}`
              : state.kind === 'tech'
                ? 'тех. окно — можно'
                : 'свободен';
          return (
            <li key={r.id} className={`wz-res-row${on ? ' selected' : ''} ${state.kind}`}>
              <button
                type="button"
                role="checkbox"
                aria-checked={on}
                className="wz-res-pick"
                disabled={state.kind === 'stop' && !on}
                title={state.kind === 'stop' ? `Ресурс закрыт: ${state.stop.reason}` : undefined}
                onClick={() => onResources(on ? resourceIds.filter((x) => x !== r.id) : [...resourceIds, r.id])}
              >
                <span className="wz-res-check" aria-hidden="true">
                  {on ? '✓' : ''}
                </span>
                <b>{r.name}</b>
                <span className={`wz-res-state ${state.kind}`}>{note}</span>
              </button>
              <div className="wz-res-timeline">
              <div
                className="wz-res-scale"
                title={interval && !compact ? 'Выбрать ресурс' : 'Кликните — бронь с этого времени'}
                role="button"
                tabIndex={0}
                aria-label={`Выбрать время: ${r.name}`}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    if (compact) setDraft({ rid: r.id, period: { ...period } });
                    else onResources([r.id]);
                  }
                }}
                onClick={(e) => pickOnBar(r.id, e)}
              >
                {pieces.map((p, i) => (
                  <i key={i} className={`piece ${p.kind}`} style={{ left: `${p.from * 100}%`, width: `${(p.to - p.from) * 100}%` }} />
                ))}
                {durationMs > 0 && <i className="pick" style={{ left: `${frac(startMs) * 100}%`, width: `${(frac(endMs) - frac(startMs)) * 100}%` }} />}
                {ticks.map((t, i) => <i key={i} className="wz-res-tick" style={{ left: `${t.at * 100}%` }} />)}
              </div>
              <div className="wz-res-tick-labels" aria-hidden="true">
                {ticks.map((t, i) => <span key={i} style={{ left: `${t.at * 100}%` }}>{t.label}</span>)}
              </div>
              </div>
            </li>
          );
        })}
        {days && !loading && !shown.length && <li className="cp-hint">Свободных ресурсов на это время нет — выберите другое время или день.</li>}
      </ul>
      </div>
      {draft && <SlotTimeDialog
        initial={draft.period}
        timezone={timezone}
        resourceName={resources.find((r) => r.id === draft.rid)?.name ?? 'Ресурс'}
        onClose={() => setDraft(null)}
        onApply={(p) => { onPeriod(p); onResources([draft.rid]); setDraft(null); }}
      />}
    </section>
  );
}


/** Нативный dialog удерживает фокус внутри и возвращает его на таймлайн при закрытии. */
function SlotTimeDialog({ initial, timezone, resourceName, onClose, onApply }: {
  initial: PeriodFields;
  timezone: string;
  resourceName: string;
  onClose: () => void;
  onApply: (period: PeriodFields) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState(initial);
  const [error, setError] = useState('');
  useEffect(() => { ref.current?.showModal(); }, []);
  const apply = () => {
    const result = periodToUtc(value, timezone);
    if ('error' in result) return setError(result.error);
    if (isPastStart(Date.parse(result.start), Date.now())) return setError('Начало брони уже прошло — выберите время позже');
    onApply(value);
  };
  return (
    <dialog ref={ref} className="wz-time-dialog" aria-label="Время брони" onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); apply(); }
    }}>
      <h3>Время брони · {resourceName}</h3>
      <p className="muted">{fmtDayTitle(value.startDate, timezone)}</p>
      <div className="df-grid">
        <label className="df-field"><span className="df-label">Время начала</span>
          <input type="time" autoFocus value={value.startTime} onChange={(e) => setValue({ ...value, startTime: e.target.value })} />
        </label>
        <label className="df-field"><span className="df-label">Дата завершения</span>
          <input type="date" min={value.startDate} value={value.endDate} onChange={(e) => setValue({ ...value, endDate: e.target.value })} />
        </label>
        <label className="df-field"><span className="df-label">Время завершения</span>
          <input type="time" value={value.endTime} onChange={(e) => setValue({ ...value, endTime: e.target.value })} />
        </label>
      </div>
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="wz-time-actions">
        <button type="button" onClick={onClose}>Отмена</button>
        <button type="button" className="primary" onClick={apply}>Применить</button>
      </div>
    </dialog>
  );
}
