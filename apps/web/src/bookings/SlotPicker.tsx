import { ColorLegend, type LegendItem } from '../ColorLegend.js';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import {
  todayIn,
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
import { durationChoices, durationText, localAt, periodToUtc, upcomingPeriod, withDuration, type PeriodFields } from './booking-form.js';
import { DatePicker } from './DatePicker.js';

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

const NIGHTS = [1, 2, 3, 5, 7];

/** Цвета таймлайна ресурса: занято, тех. окно, выбранное время (при наведении на выбранный ресурс). */
const SLOT_LEGEND: LegendItem[] = [
  { label: 'Занято', swatch: { background: '#f04438' } },
  { label: 'Тех. окно — можно', swatch: { background: '#fcd34d' }, title: 'Пересечение с тех. окном разрешено, с предупреждением' },
  { label: 'Бронь на выбранную длительность', swatch: { borderColor: 'var(--primary)', background: 'rgba(0, 122, 255, 0.18)' }, title: 'Накладка при наведении на шкалу ресурса; нажатие — выбрать это время' },
];

/**
 * Раздел «Ресурс и время» (решение владельца 2026-10-26): посередине — выбор даты, ниже — длительность
 * (почасовые группы: по умолчанию группы и +1…+3 ч, «＋» — своя) и ресурсы со шкалой занятости.
 * Прошедшие часы сегодня на шкале не показываются (идущие брони видны с левого края). Наведение на
 * шкалу — накладка брони выбранной длительности от этого места, нажатие — выбрать её; «заезд/выезд» —
 * время заезда и ночи, шкала выбирает ресурс.
 */
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
  const [draft, setDraft] = useState<{ rid: number | null; period: PeriodFields } | null>(null);
  const [hover, setHover] = useState<{ rid: number; start: number } | null>(null);
  const [askHours, setAskHours] = useState(false);
  const now = useNow();
  const today = todayIn(timezone);
  const interval = group.bookingMode === 'interval';
  const startMs = zonedTimeToUtc(period.startDate, period.startTime || '00:00', timezone).getTime();
  const endMs = zonedTimeToUtc(period.endDate, period.endTime || '00:00', timezone).getTime();
  const durationMs = endMs - startMs;
  const nights = Math.round((Date.parse(period.endDate) - Date.parse(period.startDate)) / 86_400_000);
  // «Заезд/выезд» вне встройки: шкала выбирает ресурс; иначе — бронь от места нажатия.
  const nightsMode = interval && !compact;
  // Во встройке — сутки выбранного дня; вне неё «заезд/выезд» охватывает весь период. Сегодня — с текущего часа.
  const dayStart = zonedDayRange(period.startDate, timezone).start.getTime();
  const from = period.startDate === today ? dayStart + Math.max(0, Math.floor((now - dayStart) / 3_600_000)) * 3_600_000 : dayStart;
  const range = { from, to: Math.max(from + 3_600_000, zonedDayRange(nightsMode ? period.endDate : period.startDate, timezone).end.getTime()) };
  const span = range.to - range.from;
  const frac = (ms: number) => Math.min(1, Math.max(0, (ms - range.from) / span));
  // Длительность брони от наведения: выбранная (или группы по умолчанию).
  const lengthMs = durationMs > 0 ? durationMs : group.durationMinutes * 60_000;

  const setDay = (d: string) => onPeriod(upcomingPeriod(group, d, d === period.startDate ? period.startTime : undefined, Date.now(), timezone));
  /** Начало брони под курсором: шаг 30 минут, не раньше ближайших получаса. */
  const startAt = (e: MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const dayMin = span / 60_000;
    const m = slotAt(((e.clientX - r.left) / r.width) * dayMin, dayMin);
    const step = 30 * 60_000;
    return Math.max(range.from + m * 60_000, Math.ceil(now / step) * step);
  };
  const periodFrom = (start: number): PeriodFields => {
    const s = localAt(start, timezone);
    const e = localAt(start + lengthMs, timezone);
    return { startDate: s.date, startTime: s.time, endDate: e.date, endTime: e.time };
  };
  const pickOnBar = (rid: number, e: MouseEvent<HTMLDivElement>) => {
    if (nightsMode) return onResources([rid]);
    onPeriod(periodFrom(startAt(e)));
    onResources([rid]);
  };
  const hours = durationChoices(group.durationMinutes);
  const lengthH = Math.round((durationMs / 3_600_000) * 100) / 100;
  const ghostOf = (rid: number) =>
    hover?.rid !== rid ? null : nightsMode ? { start: startMs, end: endMs } : { start: hover.start, end: hover.start + lengthMs };

  const resources = days?.resources ?? [];
  const rows = resources.map((r) => ({ r, state: slotStateOf(r.id, days?.bookings ?? [], days?.techWindows ?? [], startMs, endMs, days?.stops ?? []) }));
  const open = (s: SlotState) => s.kind !== 'busy' && s.kind !== 'stop';
  const free = rows.filter((x) => open(x.state)).length;
  const shown = onlyFree ? rows.filter((x) => open(x.state) || resourceIds.includes(x.r.id)) : rows;
  // Метки считаются по местному времени портала, включая дни перехода на летнее время.
  const firstHour = Number(localAt(range.from, timezone).time.slice(0, 2));
  const spanH = span / 3_600_000;
  const tickStep = spanH > 12 ? 4 : spanH > 6 ? 2 : 1;
  const ticks = nightsMode
    ? Array.from({ length: nights + 1 }, (_, i) => ({ at: (i + 0.5) / (nights + 1), label: `${shiftDate(period.startDate, i).slice(8, 10)}.${shiftDate(period.startDate, i).slice(5, 7)}` }))
    : Array.from({ length: 24 - firstHour }, (_, i) => firstHour + i)
        .filter((h) => h % tickStep === 0)
        .map((h) => ({ at: frac(zonedTimeToUtc(period.startDate, `${String(h).padStart(2, '0')}:00`, timezone).getTime()), label: `${h}ч` }));

  return (
    <section className="bk-section wz-slot">
      <DatePicker date={period.startDate} today={todayIn(timezone)} onDate={setDay} label={interval ? 'Дата заезда' : 'Дата брони'} />

      {nightsMode ? (
        <div className="wz-when">
          <label className="wz-when-field">
            <span className="df-label">Время заезда</span>
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
        </div>
      ) : (
        <div className="wz-when">
          {!interval && (
            <div className="wz-when-field">
              <span className="df-label">Длительность</span>
              <div className="wz-durations" role="group" aria-label="Длительность">
                {[...hours, ...(durationMs > 0 && !hours.includes(lengthH) ? [lengthH] : [])].map((h) => (
                  <button key={h} type="button" aria-pressed={lengthH === h} className={lengthH === h ? 'active' : ''} onClick={() => onPeriod(withDuration(period, h * 60, timezone))}>
                    {String(h).replace('.', ',')} ч
                  </button>
                ))}
                <button type="button" className="wz-dur-add" aria-label="Другая длительность" title="Другая длительность, ч" onClick={() => setAskHours(true)}>
                  ＋
                </button>
              </div>
            </div>
          )}
          <div className="wz-when-field">
            <span className="df-label">Время</span>
            <span className="wz-when-time">
              <b>
                {period.startTime}–{period.endDate !== period.startDate ? `${period.endDate.slice(8, 10)}.${period.endDate.slice(5, 7)} ` : ''}
                {period.endTime}
              </b>
              {durationMs > 0 && <span className="muted"> · {durationText(durationMs)}</span>}
              <button type="button" className="link" onClick={() => setDraft({ rid: resourceIds.length === 1 ? resourceIds[0] : null, period: { ...period } })}>
                Точное время
              </button>
            </span>
          </div>
          <p className="muted wz-hint">Наведите на шкалу ресурса — накладка покажет бронь на выбранную длительность; нажмите, чтобы выбрать.</p>
        </div>
      )}

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
          const ghost = ghostOf(r.id);
          const ghostState = ghost ? slotStateOf(r.id, days?.bookings ?? [], days?.techWindows ?? [], ghost.start, ghost.end, days?.stops ?? []) : null;
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
                className={`wz-res-scale${ghost ? ' hovering' : ''}`}
                title={nightsMode ? 'Выбрать ресурс' : 'Нажмите — бронь с этого времени'}
                role="button"
                tabIndex={0}
                aria-label={`Выбрать время: ${r.name}`}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    if (nightsMode) onResources([r.id]);
                    else setDraft({ rid: r.id, period: { ...period } });
                  }
                }}
                onMouseMove={(e) => {
                  if (nightsMode) return hover?.rid !== r.id && setHover({ rid: r.id, start: startMs });
                  const start = startAt(e);
                  if (hover?.rid !== r.id || hover.start !== start) setHover({ rid: r.id, start });
                }}
                onMouseLeave={() => setHover(null)}
                onClick={(e) => pickOnBar(r.id, e)}
              >
                {pieces.map((p, i) => (
                  <i key={i} className={`piece ${p.kind}`} style={{ left: `${p.from * 100}%`, width: `${(p.to - p.from) * 100}%` }} />
                ))}
                {on && durationMs > 0 && !ghost && <i className="pick" style={{ left: `${frac(startMs) * 100}%`, width: `${(frac(endMs) - frac(startMs)) * 100}%` }} />}
                {ghost && (
                  <i
                    className={`ghost${ghostState && (ghostState.kind === 'busy' || ghostState.kind === 'stop') ? ' busy' : ''}`}
                    style={{ left: `${frac(ghost.start) * 100}%`, width: `${Math.max(0, frac(ghost.end) - frac(ghost.start)) * 100}%` }}
                  >
                    <span>
                      {fmtTime(new Date(ghost.start).toISOString(), timezone)}–{fmtTime(new Date(ghost.end).toISOString(), timezone)}
                    </span>
                  </i>
                )}
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
        resourceName={resources.find((r) => r.id === draft.rid)?.name ?? null}
        onClose={() => setDraft(null)}
        onApply={(p) => { onPeriod(p); if (draft.rid) onResources([draft.rid]); setDraft(null); }}
      />}
      {askHours && <HoursDialog onClose={() => setAskHours(false)} onApply={(h) => { onPeriod(withDuration(period, Math.round(h * 60), timezone)); setAskHours(false); }} />}
    </section>
  );
}

/** Нативный dialog удерживает фокус внутри и возвращает его на таймлайн при закрытии. */
function SlotTimeDialog({ initial, timezone, resourceName, onClose, onApply }: {
  initial: PeriodFields;
  timezone: string;
  resourceName: string | null;
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
      <h3>Время брони{resourceName ? ` · ${resourceName}` : ''}</h3>
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

/** Своя длительность брони в часах (кнопка «＋» рядом с быстрым выбором). */
function HoursDialog({ onClose, onApply }: { onClose: () => void; onApply: (hours: number) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState('');
  useEffect(() => { ref.current?.showModal(); }, []);
  const hours = Number(value.replace(',', '.'));
  const ok = hours >= 0.5 && hours <= 72;
  const apply = () => ok && onApply(Math.round(hours * 2) / 2);
  return (
    <dialog ref={ref} className="wz-time-dialog" aria-label="Длительность брони" onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); apply(); }
    }}>
      <h3>Длительность брони</h3>
      <label className="df-field"><span className="df-label">Часов (шаг — полчаса)</span>
        <input inputMode="decimal" autoFocus value={value} placeholder="Например, 8" onChange={(e) => setValue(e.target.value)} />
      </label>
      {value && !ok && <p className="cp-hint error">От 0,5 до 72 часов</p>}
      <div className="wz-time-actions">
        <button type="button" onClick={onClose}>Отмена</button>
        <button type="button" className="primary" disabled={!ok} onClick={apply}>Применить</button>
      </div>
    </dialog>
  );
}
