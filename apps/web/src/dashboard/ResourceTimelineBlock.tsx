import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { addMonths, TIMELINE_MAX_MONTHS, todayIn, zonedDayRange, type CalendarBooking, type CalendarDay, type CalendarRangeDto, type CalendarResource, type CalendarTechWindow, type BookingInfoDto, type ClientBookingsDto, type MyGroupDto, type ResourceStopDto } from '@btx24/shared';
import { apiGet, apiPost } from '../api.js';
import { openCrm } from '../b24.js';
import { BookingForm, type WizardResult } from '../bookings/BookingForm.js';
import { PaymentDialog } from '../bookings/PaymentDialog.js';
import { SLOT_MINUTES } from '../calendar/layout.js';
import { ErrorBoundary } from '../ErrorBoundary.js';
import { LoadProgress } from './LoadProgress.js';
import { centeredScrollLeft, pastShare, resourceDayState, timelinePieces, withPast } from './timeline-data.js';
import { fmtDateTime, fmtMoney, fmtTime, shiftDate } from '../format.js';
import { dayKey } from '../openlines/chat-list.js';
import { DashBadge } from '../openlines/RecentCalls.js';
import { Avatar } from '../openlines/Avatar.js';

/** Период шкалы — до 30 месяцев (решение владельца 2026-10-29); дольше месяца — ячейки по месяцам. */
const MAX_DAYS = 31 * TIMELINE_MAX_MONTHS;
/** Дней в периоде — до стольких ячейки по дням, больше — по месяцам. */
export const DAY_CELLS_MAX = 31;
const POLL_MS = 60_000;

interface Timeline {
  key: string;
  startMs: number;
  endMs: number;
  resources: CalendarResource[];
  bookings: CalendarBooking[];
  techWindows: CalendarTechWindow[];
  stops: ResourceStopDto[];
  syncedAt: string | null;
  horizon: string | null;
}

/** Месяцы периода: части месяцев на краях — только дни периода. */
export function timelineMonths(days: string[]): { key: string; from: string; to: string }[] {
  const out: { key: string; from: string; to: string }[] = [];
  for (const d of days) {
    const key = d.slice(0, 7);
    const last = out[out.length - 1];
    if (last?.key === key) last.to = d;
    else out.push({ key, from: d, to: d });
  }
  return out;
}

/** Последний день календарного месяца даты. */
export const monthEnd = (date: string) => shiftDate(addMonths(`${date.slice(0, 7)}-01`, 1), -1);

/** Последний день периода, который ещё можно выбрать от `from`. */
export const lastRangeDay = (from: string) => shiftDate(addMonths(from, TIMELINE_MAX_MONTHS), -1);

/** Дни портала от выбранной даты до конца периода включительно (не больше 30 месяцев). */
export function timelineDays(today: string, to: string): string[] {
  const days = [today];
  const d = new Date(`${today}T00:00:00Z`);
  while (days.length < MAX_DAYS) {
    d.setUTCDate(d.getUTCDate() + 1);
    const next = d.toISOString().slice(0, 10);
    if (next > to) break;
    days.push(next);
  }
  return days;
}

/** Полные часы в поясе портала внутри полуоткрытого диапазона шкалы. */
export function timelineHours(startMs: number, endMs: number, timezone: string) {
  const format = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const ticks: { key: number; at: number; time: string; midnight: boolean; date: string }[] = [];
  // Проверка минут учитывает нецелые смещения и переходы на летнее время (в том числе на 30 мин).
  for (let at = Math.floor(startMs / 60_000) * 60_000 + 60_000; at < endMs; at += 60_000) {
    const time = format.format(new Date(at));
    if (!time.endsWith(':00')) continue;
    ticks.push({ key: at, at: (at - startMs) / (endMs - startMs), time, midnight: time === '00:00', date: dayKey(new Date(at).toISOString(), timezone) });
  }
  return ticks;
}

/** Имена ресурсов шкалы с прошлой загрузки: пока брони грузятся, строки ресурсов уже видны. */
const NAMES_KEY = 'btx24:timeline-resource-names';
function savedNames(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(NAMES_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}
function saveNames(resources: { id: number; name: string }[]) {
  try {
    localStorage.setItem(NAMES_KEY, JSON.stringify({ ...savedNames(), ...Object.fromEntries(resources.map((r) => [r.id, r.name])) }));
  } catch {
    // Нет хранилища (приватный режим) — строки покажутся без имён.
  }
}

/** Брони, идущие в момент `now` (полуоткрытый интервал). */
export function liveBookings<T extends Pick<CalendarBooking, 'start' | 'end'>>(bookings: T[], now: number): T[] {
  return bookings.filter(b => Date.parse(b.start) <= now && Date.parse(b.end) > now);
}

/**
 * Локальная дата шкалы независима от периода показателей: день — часы, 2–7 дней — суточные ячейки.
 * `live` — «Брони — шкала — текущие»: сегодня, только ресурсы с идущей сейчас бронью и только эти брони.
 */
export function ResourceTimelineBlock({ groups, config, timezone, onConfigure, live = false, deal, focus = null, groupTabs = false, pending = false }: {
  groups: MyGroupDto[]; config: string[] | undefined; timezone: string; onConfigure?: (groupIds: string[]) => void; live?: boolean;
  /** Встройка сделки: бронь со шкалы — по этой сделке (клиент и открытые сделки — для мастера). */
  deal?: { dealId: number; contactId: number | null; openDeals: ClientBookingsDto['openDeals'] };
  /** Начало брони сделки (встройка): шкала открывается на её дне и прокручивается к ней; брони сделки выделены. */
  focus?: string | null;
  /** Группы — кнопками рядом с заголовком (встройка сделки), а не только в окне выбора ресурсов. */
  groupTabs?: boolean;
  /** Группы ещё не известны (встройка: ждём группы и воронку сделки) — только заглушка, без запросов:
   *  иначе шкала успевает показать чужую группу и перескакивает. */
  pending?: boolean;
}) {
  const visible = groups.filter(g => g.permissions.includes('calendar.view'));
  const chosen = config?.length ? visible.filter(g => config.includes(g.id)) : visible;
  const [groupId, setGroupId] = useState('');
  const group = chosen.find(g => g.id === groupId) ?? chosen[0] ?? null;
  const [date, setDate] = useState(() => todayIn(timezone));
  const [mode, setMode] = useState<'day' | 'week' | 'month' | 'range'>('day');
  const [until, setUntil] = useState(() => shiftDate(todayIn(timezone), 6));
  const [filters, setFilters] = useState<Record<string, number[] | undefined>>({});
  const [picker, setPicker] = useState(false);
  const [data, setData] = useState<Timeline | null>(null);
  const [error, setError] = useState('');
  const [rev, setRev] = useState(0);
  const [selected, setSelected] = useState<CalendarBooking | null>(null);
  const [form, setForm] = useState<{ date: string; time: string; resourceId: number } | null>(null);
  const [payment, setPayment] = useState<{ dealId: number; bookingId: number | null; amount?: number | null; fixedDeal?: boolean } | null>(null);
  const [note, setNote] = useState('');
  const [setup, setSetup] = useState(false);
  const canCreate = !!group?.permissions.includes('booking.create');
  const canPay = groups.some(g => g.permissions.includes('payment.send'));
  const endDate = live ? date : mode === 'day' ? date : mode === 'week' ? shiftDate(date, 6) : mode === 'month' ? monthEnd(date) : until;
  const rangeError = !date || !endDate || endDate < date || endDate > lastRangeDay(date) ? `Выберите период от 1 дня до ${TIMELINE_MAX_MONTHS} месяцев.` : '';
  const days = rangeError ? [] : timelineDays(date, endDate);
  const byMonth = days.length > DAY_CELLS_MAX;
  const months = byMonth ? timelineMonths(days) : [];
  // Текущие: дата портала сменилась после полуночи — переходим на новый день.
  const today = todayIn(timezone);
  useEffect(() => { if (live && date !== today) setDate(today); }, [live, date, today]);
  // Бронь сделки — на её день (один раз на бронь: дальше менеджер листает сам).
  useEffect(() => {
    if (live || !focus) return;
    setDate(dayKey(focus, timezone));
    setMode('day');
  }, [live, focus, timezone]);
  const key = `${group?.id ?? ''}|${timezone}|${days[0] ?? ''}|${days[days.length - 1] ?? ''}`;

  useEffect(() => {
    if (pending || !group || !days.length) return;
    let active = true;
    let request = 0;
    const load = () => {
      const currentRequest = ++request;
      // Один запрос на весь период — из журнала броней приложения (без запросов к Битрикс24 по дням).
      void apiGet<CalendarRangeDto>(`/calendar/range?groupId=${encodeURIComponent(group.id)}&from=${days[0]}&to=${days[days.length - 1]}`).then(r => {
        if (!active || currentRequest !== request) return;
        setData({ key, startMs: zonedDayRange(days[0], timezone).start.getTime(), endMs: zonedDayRange(days[days.length - 1], timezone).end.getTime(), resources: r.resources, bookings: r.bookings, techWindows: r.techWindows, stops: r.stops, syncedAt: r.syncedAt, horizon: r.horizon });
        setError('');
      }, e => { if (active && currentRequest === request) setError(e instanceof Error ? e.message : 'Не удалось загрузить брони'); });
    };
    load();
    const timer = setInterval(load, POLL_MS);
    window.addEventListener('focus', load);
    window.addEventListener('btx24:mutation', load);
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', load); window.removeEventListener('btx24:mutation', load); };
    // `days` и выбранная группа выражены ключом; фильтр ресурсов не перезапрашивает календарь.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, rev, pending]);

  const current = data?.key === key && !rangeError ? data : null;
  const allResources = current?.resources ?? [];
  useEffect(() => { if (allResources.length) saveNames(allResources); }, [allResources]);
  const filter = group ? filters[group.id] : undefined;
  const nowMs = Date.now();
  const running = current && live ? liveBookings(current.bookings, nowMs) : [];
  const resources = (filter ? allResources.filter(r => filter.includes(r.id)) : allResources).filter(r => !live || running.some(b => b.resourceIds.includes(r.id)));
  const period = days.length > 1;
  const span = current ? current.endMs - current.startMs : 1;
  const ticks = current && !period ? timelineHours(current.startMs, current.endMs, timezone) : [];
  const gridWidth = 140 + (period ? (byMonth ? months.length : days.length) * 76 : Math.ceil(span / 3_600_000) * 40);
  /** День периода в виде `CalendarDay` (состояние ячейки) — из брони всего периода. */
  const dayOf = (date: string): CalendarDay => ({ date, timezone, resources: allResources, bookings: current?.bookings ?? [], techWindows: current?.techWindows ?? [], stops: current?.stops ?? [] });

  // Шкала шире экрана — по центру текущее время (в периоде — середина); один раз на загрузку периода.
  const rowsRef = useRef<HTMLDivElement>(null);
  const focusMs = focus ? Date.parse(focus) : NaN;
  const aim = current && !period && focusMs >= current.startMs && focusMs < current.endMs ? focusMs : nowMs;
  useCenteredScroll(rowsRef, current?.key ?? null, gridWidth, centerFraction(period, current?.startMs ?? 0, current?.endMs ?? 1, aim));

  /** Бронь на шкале: прошедшая — тёмно-красная (идущая — темнеет прошедшая часть), время и сумма сделки. */
  const bookingPiece = (b: CalendarBooking, key: number, from: number, to: number) => {
    const share = current ? pastShare({ from, to }, current.startMs, current.endMs, nowMs) : 0;
    const amount = b.deal?.opportunity !== null && b.deal?.opportunity !== undefined ? fmtMoney(b.deal.opportunity, b.deal.currency) : '';
    const style = { left: `${from * 100}%`, width: `${(to - from) * 100}%`, ...(share > 0 && share < 1 ? { '--past': `${share * 100}%` } : {}) } as CSSProperties;
    const cls = `tl-piece busy${share >= 1 ? ' done' : share > 0 ? ' partly-done' : ''}${b.missing ? ' missing' : ''}${deal && b.dealId === deal.dealId ? ' this-deal' : ''}`;
    const wide = to - from;
    return <button key={key} type="button" className={cls} style={style}
      title={`${deal && b.dealId === deal.dealId ? 'Бронь этой сделки · ' : ''}${fmtDateTime(b.start, timezone)} → ${fmtDateTime(b.end, timezone)}${b.deal ? ` · ${b.deal.title}` : ''}${amount ? ` · ${amount}` : ''}${share >= 1 ? ' · прошла' : ''}${b.missing ? MISSING_HINT : ''}`}
      aria-label={`Бронь ${fmtDateTime(b.start, timezone)} — ${fmtDateTime(b.end, timezone)}${amount ? `, ${amount}` : ''}`} onClick={() => setSelected(b)}>
      {wide >= 0.08 && <span>{fmtTime(b.start, timezone)}–{fmtTime(b.end, timezone)}{amount && wide >= 0.16 && <b className="tl-amount"> · {amount}</b>}</span>}
      {amount && wide >= 0.05 && wide < 0.08 && <b className="tl-amount only">{amount}</b>}
    </button>;
  };

  const changeDate = (next: string) => {
    if (!next) return;
    const duration = Math.max(0, Math.round((Date.parse(until) - Date.parse(date)) / 86_400_000));
    const nextUntil = shiftDate(next, Number.isFinite(duration) ? duration : 6);
    setDate(next); setUntil(nextUntil > lastRangeDay(next) ? lastRangeDay(next) : nextUntil); setNote('');
  };
  const move = (direction: number) => changeDate(mode === 'month' ? addMonths(date, direction) : shiftDate(date, direction * (period ? days.length : 1)));
  /** Месяц из длинного периода — по дням. */
  const openMonth = (m: { from: string; to: string }) => { setDate(m.from); setUntil(m.to); setMode('range'); setNote(''); };
  const openDay = (next: string) => { changeDate(next); setMode('day'); };
  /** Масштаб: «Месяц» — весь календарный месяц даты (с 1-го); «Период» — от выбранной даты. */
  const switchMode = (next: typeof mode) => {
    if (next === 'month') setDate(`${date.slice(0, 7)}-01`);
    if (next === 'range' && (until < date || until > lastRangeDay(date))) setUntil(shiftDate(date, 6));
    setMode(next);
    setNote('');
  };
  const createAt = (resourceId: number, fraction: number, notBefore: number, notAfter: number) => {
    if (!current || error) return;
    const slot = SLOT_MINUTES * 60_000;
    const at = current.startMs + fraction * span;
    const start = Math.max(Math.floor(at / slot) * slot, Math.ceil(notBefore / slot) * slot);
    if (start < Date.now() || start >= notAfter || start >= current.endMs) { setNote('Это время уже прошло или недоступно. Выберите другой участок шкалы.'); return; }
    const iso = new Date(start).toISOString();
    setNote(''); setForm({ date: dayKey(iso, timezone), time: fmtTime(iso, timezone), resourceId });
  };

  return <section className="day-panel dash-block dash-timeline">
    <DashBadge name="calendar" />
    <div className="timeline-heading">
      <p className="dash-attention-title muted">{live ? 'Брони · шкала · текущие' : 'Брони · шкала'}</p>
      {group && <button type="button" className="timeline-resources-trigger" onClick={() => setPicker(true)} aria-label="Выбрать группу и ресурсы шкалы"><b>{group.name}</b><span>{filter ? `Ресурсов: ${resources.length}` : 'Все ресурсы'} ⌄</span></button>}
      {visible.length > 1 && onConfigure && <button type="button" className="dash-kpi-setup" aria-label="Выбрать группы шкалы" title="Какие группы показывать" onClick={() => setSetup(true)}>⚙</button>}
    </div>
    {groupTabs && chosen.length > 1 && <div className="timeline-group-tabs" role="radiogroup" aria-label="Группа шкалы">
      {chosen.map(g => <button key={g.id} type="button" role="radio" aria-checked={g.id === group?.id} className={g.id === group?.id ? 'active' : ''} onClick={() => setGroupId(g.id)}>{g.name}</button>)}
    </div>}
    {!live && <div className="timeline-controls">
      <div className="timeline-date-nav">
        <button type="button" aria-label={period ? 'Предыдущий период шкалы' : 'Предыдущий день шкалы'} onClick={() => move(-1)}>‹</button>
        {mode === 'month'
          ? <input type="month" aria-label="Месяц шкалы" value={date.slice(0, 7)} onChange={e => e.target.value && changeDate(`${e.target.value}-01`)} />
          : <input type="date" aria-label={mode === 'range' ? 'Начало периода шкалы' : 'Дата шкалы'} value={date} onChange={e => changeDate(e.target.value)} />}
        <button type="button" aria-label={period ? 'Следующий период шкалы' : 'Следующий день шкалы'} onClick={() => move(1)}>›</button>
        <button type="button" onClick={() => openDay(todayIn(timezone))}>Сегодня</button>
      </div>
      <div className="timeline-modes" role="group" aria-label="Масштаб шкалы">
        {([['day', 'День'], ['week', '7 дней'], ['month', 'Месяц'], ['range', 'Период']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={mode === value} className={mode === value ? 'active' : ''} onClick={() => switchMode(value)}>{label}</button>)}
      </div>
      {mode === 'range' && <label className="timeline-until">по <input type="date" aria-label="Конец периода шкалы" value={until} min={date} max={lastRangeDay(date)} onChange={e => setUntil(e.target.value)} /><span className="muted">до {TIMELINE_MAX_MONTHS} месяцев{days.length > DAY_CELLS_MAX ? ' · по месяцам' : ''}</span></label>}
    </div>}
    {pending && <TimelineSkeleton ids={[]} days={days} timezone={timezone} />}
    {!pending && !visible.length && <p className="muted">Нет групп с календарём.</p>}
    {(rangeError || error) && <p className="notice error" role="alert">{rangeError || error}</p>}
    {note && <p className="notice">{note}</p>}
    {!pending && group && !current && !rangeError && !error && <TimelineSkeleton
      ids={(filters[group.id] ?? group.resourceIds).slice(0, live ? 3 : undefined)}
      days={days}
      timezone={timezone}
    />}
    {current && !resources.length && <p className="muted">{live && allResources.length ? 'Сейчас броней нет.' : allResources.length ? 'Выберите ресурсы для шкалы.' : 'В группе нет ресурсов.'}</p>}
    {current && !!resources.length && <>
      <div className="timeline-rows" ref={rowsRef}><div className="timeline-grid" style={{ minWidth: gridWidth }}>
        {period ? <PeriodAxis days={days} months={months} timezone={timezone} /> :
          <div className="timeline-axis" aria-hidden="true"><span className="timeline-now">00:00</span>{ticks.map(t => <span key={t.key} className="timeline-tick" style={{ left: `${t.at * 100}%` }}>{t.time}</span>)}<span className="timeline-end">24:00</span></div>}
        {resources.map(r => <div key={r.id} className="timeline-row">
          <span className="timeline-resource" title={`${r.name} #${r.id}`}>{r.name}</span>
          {byMonth ? <div className="timeline-period-bar" role="group" aria-label={`Месяцы: ${r.name}`}>
            {months.map(m => {
              const state = resourceMonthState(dayOf(m.from), m, r.id, timezone, nowMs);
              const status = state.bookings.length ? `Броней: ${state.bookings.length}` : state.kind === 'past' ? 'Прошло' : 'Свободно';
              return <button type="button" key={m.key} className={`timeline-period-cell ${state.kind}${state.bookings.some(b => b.missing) ? ' has-missing' : ''}${deal && state.bookings.some(b => b.dealId === deal.dealId) ? ' this-deal' : ''}`} title={`${monthLabel(m.key)} · ${r.name} · ${status}`} aria-label={`${monthLabel(m.key)}, ${r.name}: ${status}. Открыть месяц по дням`} onClick={() => openMonth(m)}>{state.bookings.length || ''}</button>;
            })}
          </div> : period ? <div className="timeline-period-bar" role="group" aria-label={`Дни: ${r.name}`}>
            {days.map(date => {
              const d = dayOf(date);
              const state = resourceDayState(d, r.id, timezone, nowMs);
              const status = state.bookings.length ? `Броней: ${state.bookings.length}` : state.kind === 'past' ? 'Прошло' : state.stops.length ? 'Стоп' : 'Свободно';
              const stopText = state.stops.map(s => s.reason).join('; ');
              return <button type="button" key={d.date} className={`timeline-period-cell ${state.kind}${state.stops.length ? ' has-stop' : ''}${state.bookings.some(b => b.missing) ? ' has-missing' : ''}`} title={`${d.date} · ${r.name} · ${status}${stopText ? ` · Стоп: ${stopText}` : ''}`} aria-label={`${d.date}, ${r.name}: ${status}. Открыть день`} onClick={() => openDay(d.date)}>{state.bookings.length || (state.kind !== 'past' && state.stops.length ? 'Стоп' : '')}</button>;
            })}
          </div> : <div className={`timeline-bar${live ? ' live' : ''}`} role="group" aria-label={`Занятость: ${r.name}`}>
            {ticks.map(t => <i key={t.key} className="timeline-hour" style={{ left: `${t.at * 100}%` }} aria-hidden="true" />)}
            {live && nowMs > current.startMs && nowMs < current.endMs && <i className="timeline-now-line" style={{ left: `${((nowMs - current.startMs) / span) * 100}%` }} aria-hidden="true" />}
            {live ? running.filter(b => b.resourceIds.includes(r.id)).map(b => {
              const from = Math.max(0, (Date.parse(b.start) - current.startMs) / span);
              const to = Math.min(1, (Date.parse(b.end) - current.startMs) / span);
              return bookingPiece(b, b.id, from, to);
            }) : withPast(timelinePieces(current, r.id, current.startMs, current.endMs), current.startMs, current.endMs, nowMs).map((p, i) => {
              const style = { left: `${p.from * 100}%`, width: `${(p.to - p.from) * 100}%` };
              const booking = p.kind === 'booked' && p.bookingId !== null ? current.bookings.find(b => b.id === p.bookingId) : undefined;
              if (booking) return bookingPiece(booking, i, p.from, p.to);
              if (p.kind === 'past') return <span key={i} className="tl-piece past" style={style} title="Время прошло — бронь только на будущее" aria-hidden="true" />;
              if (p.kind === 'stop') return <span key={i} className="tl-piece stopped" style={style} title={`Стоп: ${p.reason}`} aria-label={`${r.name}: стоп — ${p.reason}`}>{p.to - p.from >= 0.08 ? 'Стоп' : ''}</span>;
              const title = p.kind === 'tech' ? 'Тех. окно — бронь возможна · нажмите, чтобы забронировать' : 'Свободно · нажмите, чтобы забронировать';
              return canCreate && !error && current.endMs > Date.now() ? <button key={i} type="button" className="tl-piece free" style={style} title={title} aria-label={`Забронировать ${r.name}`} onClick={e => { const bar = e.currentTarget.parentElement!.getBoundingClientRect(); createAt(r.id, (e.clientX - bar.left) / bar.width, current.startMs + p.from * span, current.startMs + p.to * span); }} /> : <div key={i} className="tl-piece free" style={style} title="Свободно" />;
            })}
          </div>}
        </div>)}
      </div></div>
      <p className="timeline-legend muted">{live ? 'Брони, которые идут сейчас; синяя черта — текущее время. ' : byMonth ? 'Число — брони ресурса за месяц; красный — есть брони. Нажмите месяц, чтобы открыть его по дням. ' : period ? 'Красный день — есть хотя бы одна бронь, серый — прошедший день без брони. Нажмите день для часовой шкалы. ' : 'Зелёное — свободно, красное — бронь, серое — прошедшее время (бронь только на будущее). '}{!live && 'Серый штрих — стоп, бронирование закрыто. '}<SyncNote syncedAt={current.syncedAt} horizon={current.horizon} until={days[days.length - 1]} timezone={timezone} /></p>
    </>}
    {selected && <TimelineBooking booking={selected} resources={new Map(allResources.map(r => [r.id, r.name]))} timezone={timezone} canCreate={!!group?.permissions.includes('booking.create')} canCancel={!!group?.permissions.includes('booking.cancel')} onResolved={text => { setSelected(null); setNote(text); setRev(n => n + 1); }} onClose={() => setSelected(null)} />}
    {form && group && <ErrorBoundary where="booking-form" onClose={() => setForm(null)}><BookingForm groups={groups} timezone={timezone} context={{ ...form, groupId: group.id, ...(deal ? { dealId: deal.dealId, contactId: deal.contactId, openDeals: deal.openDeals } : {}) }} onClose={() => setForm(null)} onDone={(r: WizardResult) => { setForm(null); if (r.payment && r.dealId && canPay) setPayment({ dealId: r.dealId, bookingId: r.booking?.bookingId ?? null, amount: r.payment.amount, fixedDeal: r.payment.fixedDeal }); setNote(r.note); setRev(n => n + 1); }} /></ErrorBoundary>}
    {payment && <PaymentDialog dealId={payment.dealId} bookingId={payment.bookingId} initialAmount={payment.amount} fixedDeal={payment.fixedDeal} timezone={timezone} onClose={() => setPayment(null)} />}
    {picker && group && <TimelineResourcesPicker groups={chosen} groupId={group.id} resources={allResources} filter={filter} stops={current?.stops ?? []} loading={!current} onGroup={setGroupId} onFilter={ids => setFilters(prev => ({ ...prev, [group.id]: ids }))} onClose={() => setPicker(false)} />}
    {setup && <TimelineSetup groups={visible} value={chosen.map(g => g.id)} onClose={() => setSetup(false)} onSave={ids => { setSetup(false); onConfigure?.(ids.length === visible.length ? [] : ids); }} />}
  </section>;
}

function TimelineResourcesPicker({ groups, groupId, resources, filter, stops, loading, onGroup, onFilter, onClose }: {
  groups: MyGroupDto[]; groupId: string; resources: CalendarDay['resources']; filter: number[] | undefined; stops: ResourceStopDto[]; loading: boolean; onGroup: (id: string) => void; onFilter: (ids: number[] | undefined) => void; onClose: () => void;
}) {
  return createPortal(<div className="sheet-backdrop" onClick={onClose}><div className="sheet timeline-picker" role="dialog" aria-modal="true" aria-label="Группа и ресурсы шкалы" onClick={e => e.stopPropagation()} onKeyDown={e => { if (e.key === 'Escape') onClose(); }}>
    <header><h2>Группа и ресурсы</h2><button type="button" autoFocus aria-label="Закрыть выбор ресурсов" onClick={onClose}>×</button></header>
    <div className="wz-groups" role="radiogroup" aria-label="Группа ресурсов">{groups.map(g => <button key={g.id} type="button" role="radio" aria-checked={g.id === groupId} className={`wz-group${g.id === groupId ? ' selected' : ''}`} onClick={() => onGroup(g.id)}><b>{g.name}</b><span className="muted">ресурсов: {g.resourceIds.length}</span></button>)}</div>
    <button type="button" className="timeline-all-resources" aria-pressed={!filter} onClick={() => onFilter(undefined)}>Все ресурсы</button>
    {loading ? <p className="muted">Загрузка ресурсов…</p> : <div className="wz-resources" role="group" aria-label="Ресурсы шкалы">{resources.map(r => { const on = !filter || filter.includes(r.id); const stop = stops.find(s => s.resourceId === r.id); return <button key={r.id} type="button" aria-pressed={on} className={`wz-resource${on ? ' selected' : ''}${stop ? ' has-stop' : ''}`} title={stop ? `Стоп в выбранном периоде: ${stop.reason}` : r.name} onClick={() => onFilter(on ? (filter ?? resources.map(x => x.id)).filter(id => id !== r.id) : [...(filter ?? []), r.id])}>{r.name}{stop && <small>Стоп</small>}</button>; })}</div>}
    <footer className="form-actions"><button type="button" className="primary" onClick={onClose}>Готово</button></footer>
  </div></div>, document.body);
}

const MISSING_HINT = ' · удалена в Битрикс24 — нажмите, чтобы решить: восстановить или удалить в приложении';

/**
 * Окно брони со шкалы: время, ресурсы, сделка и клиент (клиент — по сделке, правами сотрудника).
 * Бронь удалена в Битрикс24, а в приложении есть (`missing`) — пояснение и решение: восстановить или
 * удалить в приложении (как в карточке брони календаря; права в группе ресурса проверит сервер).
 */
function TimelineBooking({ booking, resources, timezone, canCreate, canCancel, onResolved, onClose }: {
  booking: CalendarBooking; resources: Map<number, string>; timezone: string; canCreate: boolean; canCancel: boolean; onResolved: (note: string) => void; onClose: () => void;
}) {
  const [client, setClient] = useState<ClientBookingsDto | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [decideError, setDecideError] = useState('');
  const decide = async (what: 'recreate' | 'remove-in-app') => {
    const text = what === 'recreate'
      ? 'Восстановить бронь? Она будет создана в Битрикс24 заново на то же время и ресурс, у брони будет новый номер.'
      : 'Удалить бронь в приложении? В истории останется запись об удалении.';
    if (!confirm(text)) return;
    setBusy(true);
    setDecideError('');
    try {
      await apiPost(`/bookings/${booking.id}/${what}`, {});
      window.dispatchEvent(new Event('btx24:mutation'));
      onResolved(what === 'recreate' ? `Бронь #${booking.id} восстановлена — создана в Битрикс24 заново.` : `Бронь #${booking.id} удалена в приложении.`);
    } catch (e) {
      setDecideError(e instanceof Error ? e.message : 'Не удалось выполнить действие');
      setBusy(false);
    }
  };
  const [info, setInfo] = useState<BookingInfoDto | null>(null);
  // Карточка брони (сделка, оплата, клиент с фото, поля группы, товары); нет права — что есть на шкале.
  useEffect(() => {
    if (booking.missing) return;
    let active = true;
    apiGet<BookingInfoDto>(`/bookings/${booking.id}/info`).then((r) => active && setInfo(r), () => undefined);
    return () => void (active = false);
  }, [booking.id, booking.missing]);
  useEffect(() => {
    if (!booking.dealId) return;
    let active = true;
    apiGet<ClientBookingsDto>(`/deals/${booking.dealId}/bookings`).then(
      (r) => active && setClient(r),
      (e) => active && setError(e instanceof Error ? e.message : 'Не удалось загрузить клиента'),
    );
    return () => void (active = false);
  }, [booking.dealId]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  const contact = client?.contact ?? null;
  const resourceNames = info?.booking.resources.length ? info.booking.resources : booking.resourceIds.map((id) => resources.get(id) ?? `Ресурс #${id}`);
  const sameDay = dayKey(booking.start, timezone) === dayKey(booking.end, timezone);
  const when = sameDay
    ? <><b>{fmtTime(booking.start, timezone)}</b><span className="tb-arrow" aria-hidden="true">→</span><b>{fmtTime(booking.end, timezone)}</b></>
    : <><b>{fmtDateTime(booking.start, timezone)}</b><span className="tb-arrow" aria-hidden="true">→</span><b>{fmtDateTime(booking.end, timezone)}</b></>;
  const deal = info?.deal ?? (booking.dealId ? { id: booking.dealId, title: booking.deal?.title ?? `Сделка #${booking.dealId}`, stage: null, amount: booking.deal?.opportunity ?? null, currency: booking.deal?.currency ?? null, paid: null, assigned: null } : null);
  const person = info?.client ?? (contact ? { id: contact.id, name: contact.name || `Контакт #${contact.id}`, photo: null, phones: [] } : null);
  const fields = info?.fields.length ? info.fields : booking.fields.filter((f) => f.inView);
  return createPortal(
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet timeline-booking tb" role="dialog" aria-modal="true" aria-label={`Бронь #${booking.id}`} onClick={(e) => e.stopPropagation()}>
        <header className="tb-head">
          <div>
            <h2>Бронь #{booking.id}</h2>
            <span className="muted tb-date">{new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(booking.start))}</span>
          </div>
          <button type="button" className="tb-close" aria-label="Закрыть" disabled={busy} onClick={onClose}>
            ×
          </button>
        </header>
        {booking.missing && (
          <div className="missing-decision" role="alert">
            <b>Спорная бронь: удалена в Битрикс24, а в приложении осталась</b>
            <span className="muted">
              Слот в Битрикс24 сейчас свободен — его может занять другая бронь. «Восстановить бронь» — бронь снова создаётся в Битрикс24 на это же
              время и ресурс (со связью со сделкой, номер будет новый); «Удалить бронь в приложении» — бронь уходит в историю как удалённая.
            </span>
            <div className="form-actions">
              <button type="button" className="primary" disabled={busy || !canCreate} title={canCreate ? undefined : 'Нет права создавать брони'} onClick={() => void decide('recreate')}>
                Восстановить бронь
              </button>
              <button type="button" className="danger-outline" disabled={busy || !canCancel} title={canCancel ? undefined : 'Нет права снимать брони'} onClick={() => void decide('remove-in-app')}>
                Удалить бронь в приложении
              </button>
            </div>
            {decideError && <p className="notice error">{decideError}</p>}
          </div>
        )}
        <div className="tb-cards">
          {resourceNames.map((name) => (
            <section key={name} className="tb-card tb-resource">
              <span className="tb-label">Ресурс</span>
              <b className="tb-title">{name}</b>
              <span className="tb-time">{when}</span>
            </section>
          ))}
          <section className={`tb-card tb-deal${deal ? '' : ' empty'}`}>
            <span className="tb-label">Сделка</span>
            {deal ? (
              <>
                <button type="button" className="link tb-title" onClick={() => openCrm('deal', deal.id)} title="Открыть сделку">
                  {deal.title}
                </button>
                {deal.amount !== null && <span className="tb-amount">{fmtMoney(deal.amount, deal.currency)}</span>}
                {(deal.paid !== null || deal.stage) && (
                  <span className="muted tb-sub">
                    {deal.stage}
                    {deal.stage && deal.paid !== null ? ' · ' : ''}
                    {deal.paid !== null && `оплачено ${fmtMoney(deal.paid, deal.currency)}`}
                  </span>
                )}
              </>
            ) : (
              <span className="muted">Без сделки — служебная бронь</span>
            )}
          </section>
        </div>
        {booking.dealId && (
          <section className="tb-client">
            {person ? (
              <>
                <Avatar src={person.photo} name={person.name} size={40} />
                <span className="tb-client-text">
                  <button type="button" className="link tb-client-name" onClick={() => openCrm('contact', person.id)}>
                    {person.name}
                  </button>
                  <span className="muted">
                    {person.phones.join(' · ')}
                    {client && client.won.count > 0 && `${person.phones.length ? ' · ' : ''}сделок: ${client.won.count}${client.won.avgCheck !== null ? `, средний чек ${fmtMoney(client.won.avgCheck, client.won.currency)}` : ''}`}
                  </span>
                </span>
                {deal?.assigned && <span className="tb-assigned muted" title="Ответственный по сделке">{deal.assigned}</span>}
              </>
            ) : error ? (
              <span className="muted">{error}</span>
            ) : !client && !info ? (
              <span className="muted">Загрузка клиента…</span>
            ) : (
              <span className="muted">Контакта у сделки нет</span>
            )}
          </section>
        )}
        {!!fields.length && (
          <dl className="tb-fields">
            {fields.map((f) => (
              <div key={f.code} className="tb-field">
                <dt>{f.label}</dt>
                <dd>{f.value || '—'}</dd>
              </div>
            ))}
          </dl>
        )}
        {!!info?.products.length && (
          <ul className="tb-products">
            {info.products.map((p, i) => (
              <li key={i}>
                <span>{p.name}</span>
                <span className="muted">{p.quantity} × {fmtMoney(p.price, deal?.currency ?? null)}</span>
                <b>{fmtMoney(p.sum, deal?.currency ?? null)}</b>
              </li>
            ))}
          </ul>
        )}
        {booking.description && <p className="muted tb-desc">{booking.description}</p>}
      </div>
    </div>,
    document.body,
  );
}

/** Какие группы показывать в выборе шкалы. */
function TimelineSetup({ groups, value, onSave, onClose }: { groups: MyGroupDto[]; value: string[]; onSave: (ids: string[]) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(() => new Set(value));
  return createPortal(
    <div className="sheet-backdrop" onClick={onClose}>
      <form
        className="sheet kpi-setup"
        role="dialog"
        aria-modal="true"
        aria-label="Группы шкалы"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          onSave(groups.filter((g) => draft.has(g.id)).map((g) => g.id));
        }}
      >
        <header>
          <h2>Группы шкалы</h2>
          <button type="button" aria-label="Закрыть" onClick={onClose}>
            ×
          </button>
        </header>
        {groups.map((g) => (
          <label key={g.id} className="check-row">
            <input
              type="checkbox"
              checked={draft.has(g.id)}
              onChange={(e) => {
                const next = new Set(draft);
                if (e.target.checked) next.add(g.id);
                else next.delete(g.id);
                setDraft(next);
              }}
            />{' '}
            {g.name}
          </label>
        ))}
        <footer className="sheet-actions">
          <button type="button" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="primary" disabled={!draft.size}>
            Сохранить
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}

/**
 * Шкала, пока брони грузятся: ось и строки ресурсов группы (их число известно, имена — с прошлой
 * загрузки), на месте броней — бегущая полоса загрузки (решение владельца 2026-10-26).
 */
/** Что держать по центру прокрутки: период — середина, день — текущее время (не сегодня — начало дня). */
function centerFraction(period: boolean, startMs: number, endMs: number, now: number): number | null {
  if (period) return 0.5;
  return now >= startMs && now < endMs ? (now - startMs) / (endMs - startMs) : null;
}

/** Прокрутить шкалу к нужному месту — один раз на `key` (опрос раз в минуту прокрутку не сбивает). */
function useCenteredScroll(ref: RefObject<HTMLDivElement | null>, key: string | null, gridWidth: number, fraction: number | null) {
  const done = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || key === null || done.current === key) return;
    done.current = key;
    if (el.scrollWidth <= el.clientWidth) return;
    el.scrollLeft = fraction === null ? 0 : centeredScrollLeft(gridWidth, el.clientWidth, fraction);
  });
}

function TimelineSkeleton({ ids, days, timezone }: { ids: number[]; days: string[]; timezone: string }) {
  const names = savedNames();
  const period = days.length > 1;
  const startMs = zonedDayRange(days[0], timezone).start.getTime();
  const endMs = zonedDayRange(days[days.length - 1], timezone).end.getTime();
  const ticks = period ? [] : timelineHours(startMs, endMs, timezone);
  const gridWidth = 140 + (period ? (days.length > DAY_CELLS_MAX ? timelineMonths(days).length : days.length) * 76 : Math.ceil((endMs - startMs) / 3_600_000) * 40);
  const rowsRef = useRef<HTMLDivElement>(null);
  useCenteredScroll(rowsRef, days.join(','), gridWidth, centerFraction(period, startMs, endMs, Date.now()));
  // Строка загрузки — вне прокручиваемой шкалы: крутящийся спиннер внутри неё на 1–2 px менял высоту
  // содержимого, и вертикальная полоса шкалы включалась и выключалась («дрожание», 2026-10-27).
  return <><div className="timeline-rows" aria-busy="true" ref={rowsRef}>
    <div className="timeline-grid" style={{ minWidth: gridWidth }}>
      {period ? <PeriodAxis days={days} months={days.length > DAY_CELLS_MAX ? timelineMonths(days) : []} timezone={timezone} /> :
        <div className="timeline-axis" aria-hidden="true"><span className="timeline-now">00:00</span>{ticks.map(t => <span key={t.key} className="timeline-tick" style={{ left: `${t.at * 100}%` }}>{t.time}</span>)}<span className="timeline-end">24:00</span></div>}
      {ids.map(id => <div key={id} className="timeline-row">
        <span className="timeline-resource">{names[id] ?? <i className="sk-line" aria-hidden="true" />}</span>
        <div className="timeline-bar loading" aria-hidden="true" />
      </div>)}
    </div>
  </div>
  <p className="muted timeline-loading" role="status"><span className="spinner" aria-hidden="true" /> <LoadProgress name="timeline" label="Загружаем брони" /></p></>;
}

const monthLabel = (key: string) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', month: 'short', year: 'numeric' }).format(new Date(`${key}-01T12:00:00Z`)).replace(' г.', '');

/** Ось периода: дни (до месяца) или месяцы. */
function PeriodAxis({ days, months, timezone }: { days: string[]; months: { key: string }[]; timezone: string }) {
  if (months.length) return <div className="timeline-day-axis">{months.map(m => <span key={m.key}>{monthLabel(m.key)}</span>)}</div>;
  return <div className="timeline-day-axis">{days.map(d => <span key={d}>{new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, weekday: 'short', day: '2-digit', month: '2-digit' }).format(zonedDayRange(d, timezone).start)}</span>)}</div>;
}

/** Ячейка месяца: брони ресурса, пересекающие дни периода в этом месяце; прошедший месяц без броней — «past». */
export function resourceMonthState(day: CalendarDay, month: { from: string; to: string }, resourceId: number, timezone: string, now = Date.now()): { bookings: CalendarBooking[]; kind: 'booked' | 'free' | 'past' } {
  const start = zonedDayRange(month.from, timezone).start.getTime();
  const end = zonedDayRange(month.to, timezone).end.getTime();
  const bookings = day.bookings.filter(b => b.resourceIds.includes(resourceId) && Date.parse(b.start) < end && Date.parse(b.end) > start);
  return { bookings, kind: bookings.length ? 'booked' : end <= now ? 'past' : 'free' };
}

/** Откуда данные шкалы: журнал приложения, сверенный с Битрикс24; дальше горизонта сверки — предупреждение. */
function SyncNote({ syncedAt, horizon, until, timezone }: { syncedAt: string | null; horizon: string | null; until: string | undefined; timezone: string }) {
  return <>
    {syncedAt && <span title="Брони берутся из базы приложения; сверка с Битрикс24 — по событиям и раз в 10 минут">Сверено с Битрикс24: {fmtDateTime(syncedAt, timezone)}.</span>}
    {horizon && until && until > horizon && <span className="timeline-horizon"> Брони после {horizon.split('-').reverse().join('.')} сверяются не все (горизонт сверки — в настройках бронирований).</span>}
  </>;
}
