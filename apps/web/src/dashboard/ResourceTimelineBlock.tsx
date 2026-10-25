import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { todayIn, zonedDayRange, type CalendarBooking, type CalendarDay, type CalendarTechWindow, type ClientBookingsDto, type MyGroupDto, type ResourceStopDto } from '@btx24/shared';
import { apiGet } from '../api.js';
import { openCrm } from '../b24.js';
import { BookingForm, type WizardResult } from '../bookings/BookingForm.js';
import { PaymentDialog } from '../bookings/PaymentDialog.js';
import { SLOT_MINUTES } from '../calendar/layout.js';
import { ErrorBoundary } from '../ErrorBoundary.js';
import { resourceDayState, timelinePieces } from './timeline-data.js';
import { fmtDateTime, fmtMoney, fmtTime, shiftDate } from '../format.js';
import { dayKey } from '../openlines/chat-list.js';
import { DashBadge } from '../openlines/RecentCalls.js';

/** Не больше7дней одновременно: ограничиваем число запросов календаря и сохраняем читаемость. */
const MAX_DAYS = 7;
const POLL_MS = 60_000;

interface Timeline {
  key: string;
  startMs: number;
  endMs: number;
  days: CalendarDay[];
  bookings: CalendarBooking[];
  techWindows: CalendarTechWindow[];
  stops: ResourceStopDto[];
}

/** Дни портала от выбранной даты до конца периода включительно, не больше недели. */
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

/** Брони, идущие в момент `now` (полуоткрытый интервал). */
export function liveBookings<T extends Pick<CalendarBooking, 'start' | 'end'>>(bookings: T[], now: number): T[] {
  return bookings.filter(b => Date.parse(b.start) <= now && Date.parse(b.end) > now);
}

/**
 * Локальная дата шкалы независима от периода показателей: день — часы, 2–7 дней — суточные ячейки.
 * `live` — «Брони — шкала — текущие»: сегодня, только ресурсы с идущей сейчас бронью и только эти брони.
 */
export function ResourceTimelineBlock({ groups, config, timezone, onConfigure, live = false }: {
  groups: MyGroupDto[]; config: string[] | undefined; timezone: string; onConfigure: (groupIds: string[]) => void; live?: boolean;
}) {
  const visible = groups.filter(g => g.permissions.includes('calendar.view'));
  const chosen = config?.length ? visible.filter(g => config.includes(g.id)) : visible;
  const [groupId, setGroupId] = useState('');
  const group = chosen.find(g => g.id === groupId) ?? chosen[0] ?? null;
  const [date, setDate] = useState(() => todayIn(timezone));
  const [mode, setMode] = useState<'day' | 'week' | 'range'>('day');
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
  const endDate = live ? date : mode === 'day' ? date : mode === 'week' ? shiftDate(date, 6) : until;
  const rangeError = !date || !endDate || endDate < date || endDate > shiftDate(date, 6) ? 'Выберите период от 1 до 7 дней.' : '';
  const days = rangeError ? [] : timelineDays(date, endDate);
  // Текущие: дата портала сменилась после полуночи — переходим на новый день.
  const today = todayIn(timezone);
  useEffect(() => { if (live && date !== today) setDate(today); }, [live, date, today]);
  const key = `${group?.id ?? ''}|${timezone}|${days.join(',')}`;

  useEffect(() => {
    if (!group || !days.length) return;
    let active = true;
    let request = 0;
    const load = () => {
      const currentRequest = ++request;
      void Promise.all(days.map(day => apiGet<CalendarDay>(`/calendar?date=${day}&groupId=${encodeURIComponent(group.id)}`))).then(list => {
        if (!active || currentRequest !== request) return;
        const bookings = [...new Map(list.flatMap(x => x.bookings).map(b => [b.id, b])).values()];
        const techWindows = [...new Map(list.flatMap(x => x.techWindows).map(t => [`${t.resourceId}:${t.start}`, t])).values()];
        const stops = [...new Map(list.flatMap(x => x.stops ?? []).map(s => [s.id, s])).values()];
        setData({ key, startMs: zonedDayRange(days[0], timezone).start.getTime(), endMs: zonedDayRange(days[days.length - 1], timezone).end.getTime(), days: list, bookings, techWindows, stops });
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
  }, [key, rev]);

  const current = data?.key === key && !rangeError ? data : null;
  const allResources = current?.days[0]?.resources ?? [];
  const filter = group ? filters[group.id] : undefined;
  const nowMs = Date.now();
  const running = current && live ? liveBookings(current.bookings, nowMs) : [];
  const resources = (filter ? allResources.filter(r => filter.includes(r.id)) : allResources).filter(r => !live || running.some(b => b.resourceIds.includes(r.id)));
  const period = days.length > 1;
  const span = current ? current.endMs - current.startMs : 1;
  const ticks = current && !period ? timelineHours(current.startMs, current.endMs, timezone) : [];
  const gridWidth = 140 + (period ? days.length * 76 : Math.ceil(span / 3_600_000) * 40);

  const changeDate = (next: string) => {
    if (!next) return;
    const duration = Math.max(0, Math.min(6, Math.round((Date.parse(until) - Date.parse(date)) / 86_400_000)));
    setDate(next); setUntil(shiftDate(next, Number.isFinite(duration) ? duration : 6)); setNote('');
  };
  const move = (direction: number) => changeDate(shiftDate(date, direction * (period ? days.length : 1)));
  const openDay = (next: string) => { changeDate(next); setMode('day'); };
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
      {visible.length > 1 && <button type="button" className="dash-kpi-setup" aria-label="Выбрать группы шкалы" title="Какие группы показывать" onClick={() => setSetup(true)}>⚙</button>}
    </div>
    {!live && <div className="timeline-controls">
      <div className="timeline-date-nav">
        <button type="button" aria-label={period ? 'Предыдущий период шкалы' : 'Предыдущий день шкалы'} onClick={() => move(-1)}>‹</button>
        <input type="date" aria-label="Дата шкалы" value={date} onChange={e => changeDate(e.target.value)} />
        <button type="button" aria-label={period ? 'Следующий период шкалы' : 'Следующий день шкалы'} onClick={() => move(1)}>›</button>
        <button type="button" onClick={() => openDay(todayIn(timezone))}>Сегодня</button>
      </div>
      <div className="timeline-modes" role="group" aria-label="Масштаб шкалы">
        {([['day', 'День'], ['week', '7 дней'], ['range', 'Период']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={mode === value} className={mode === value ? 'active' : ''} onClick={() => setMode(value)}>{label}</button>)}
      </div>
      {mode === 'range' && <label className="timeline-until">по <input type="date" aria-label="Конец периода шкалы" value={until} min={date} max={shiftDate(date, 6)} onChange={e => setUntil(e.target.value)} /><span className="muted">до 7 дней</span></label>}
    </div>}
    {!visible.length && <p className="muted">Нет групп с календарём.</p>}
    {(rangeError || error) && <p className="notice error" role="alert">{rangeError || error}</p>}
    {note && <p className="notice">{note}</p>}
    {group && !current && !rangeError && !error && <p className="muted">Загружаем брони…</p>}
    {current && !resources.length && <p className="muted">{live && allResources.length ? 'Сейчас броней нет.' : allResources.length ? 'Выберите ресурсы для шкалы.' : 'В группе нет ресурсов.'}</p>}
    {current && !!resources.length && <>
      <div className="timeline-rows"><div className="timeline-grid" style={{ minWidth: gridWidth }}>
        {period ? <div className="timeline-day-axis">{current.days.map(d => <span key={d.date}>{new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, weekday: 'short', day: '2-digit', month: '2-digit' }).format(zonedDayRange(d.date, timezone).start)}</span>)}</div> :
          <div className="timeline-axis" aria-hidden="true"><span className="timeline-now">00:00</span>{ticks.map(t => <span key={t.key} className="timeline-tick" style={{ left: `${t.at * 100}%` }}>{t.time}</span>)}<span className="timeline-end">24:00</span></div>}
        {resources.map(r => <div key={r.id} className="timeline-row">
          <span className="timeline-resource" title={`${r.name} #${r.id}`}>{r.name}</span>
          {period ? <div className="timeline-period-bar" role="group" aria-label={`Дни: ${r.name}`}>
            {current.days.map(d => {
              const state = resourceDayState(d, r.id, timezone);
              const status = state.bookings.length ? `Броней: ${state.bookings.length}` : state.stops.length ? 'Стоп' : 'Свободно';
              const stopText = state.stops.map(s => s.reason).join('; ');
              return <button type="button" key={d.date} className={`timeline-period-cell ${state.kind}${state.stops.length ? ' has-stop' : ''}`} title={`${d.date} · ${r.name} · ${status}${stopText ? ` · Стоп: ${stopText}` : ''}`} aria-label={`${d.date}, ${r.name}: ${status}. Открыть день`} onClick={() => openDay(d.date)}>{state.bookings.length || (state.stops.length ? 'Стоп' : '')}</button>;
            })}
          </div> : <div className={`timeline-bar${live ? ' live' : ''}`} role="group" aria-label={`Занятость: ${r.name}`}>
            {ticks.map(t => <i key={t.key} className="timeline-hour" style={{ left: `${t.at * 100}%` }} aria-hidden="true" />)}
            {live && nowMs > current.startMs && nowMs < current.endMs && <i className="timeline-now-line" style={{ left: `${((nowMs - current.startMs) / span) * 100}%` }} aria-hidden="true" />}
            {live ? running.filter(b => b.resourceIds.includes(r.id)).map(b => {
              const from = Math.max(0, (Date.parse(b.start) - current.startMs) / span);
              const to = Math.min(1, (Date.parse(b.end) - current.startMs) / span);
              return <button key={b.id} type="button" className="tl-piece busy" style={{ left: `${from * 100}%`, width: `${(to - from) * 100}%` }} title={`${fmtDateTime(b.start, timezone)} → ${fmtDateTime(b.end, timezone)}${b.deal ? ` · ${b.deal.title}` : ''}`} aria-label={`Бронь ${fmtDateTime(b.start, timezone)} — ${fmtDateTime(b.end, timezone)}`} onClick={() => setSelected(b)}>{to - from >= 0.08 && <span>{fmtTime(b.start, timezone)}–{fmtTime(b.end, timezone)}</span>}</button>;
            }) : timelinePieces(current, r.id, current.startMs, current.endMs).map((p, i) => {
              const style = { left: `${p.from * 100}%`, width: `${(p.to - p.from) * 100}%` };
              const booking = p.kind === 'booked' && p.bookingId !== null ? current.bookings.find(b => b.id === p.bookingId) : undefined;
              if (booking) return <button key={i} type="button" className="tl-piece busy" style={style} title={`${fmtDateTime(booking.start, timezone)} → ${fmtDateTime(booking.end, timezone)}${booking.deal ? ` · ${booking.deal.title}` : ''}`} aria-label={`Бронь ${fmtDateTime(booking.start, timezone)} — ${fmtDateTime(booking.end, timezone)}`} onClick={() => setSelected(booking)}>{p.to - p.from >= 0.08 && <span>{fmtTime(booking.start, timezone)}–{fmtTime(booking.end, timezone)}</span>}</button>;
              if (p.kind === 'stop') return <span key={i} className="tl-piece stopped" style={style} title={`Стоп: ${p.reason}`} aria-label={`${r.name}: стоп — ${p.reason}`}>{p.to - p.from >= 0.08 ? 'Стоп' : ''}</span>;
              const title = p.kind === 'tech' ? 'Тех. окно — бронь возможна · нажмите, чтобы забронировать' : 'Свободно · нажмите, чтобы забронировать';
              return canCreate && !error && current.endMs > Date.now() ? <button key={i} type="button" className="tl-piece free" style={style} title={title} aria-label={`Забронировать ${r.name}`} onClick={e => { const bar = e.currentTarget.parentElement!.getBoundingClientRect(); createAt(r.id, (e.clientX - bar.left) / bar.width, current.startMs + p.from * span, current.startMs + p.to * span); }} /> : <div key={i} className="tl-piece free" style={style} title="Свободно" />;
            })}
          </div>}
        </div>)}
      </div></div>
      <p className="timeline-legend muted">{live ? 'Брони, которые идут сейчас; синяя черта — текущее время. ' : period ? 'Красный день — есть хотя бы одна бронь. Нажмите день для часовой шкалы. ' : 'Зелёное — свободно, красное — бронь. '}{!live && 'Серый штрих — стоп, бронирование закрыто.'}</p>
    </>}
    {selected && <TimelineBooking booking={selected} resources={new Map(allResources.map(r => [r.id, r.name]))} timezone={timezone} onClose={() => setSelected(null)} />}
    {form && group && <ErrorBoundary where="booking-form" onClose={() => setForm(null)}><BookingForm groups={groups} timezone={timezone} context={{ ...form, groupId: group.id }} onClose={() => setForm(null)} onDone={(r: WizardResult) => { setForm(null); if (r.payment && r.dealId && canPay) setPayment({ dealId: r.dealId, bookingId: r.booking?.bookingId ?? null, amount: r.payment.amount, fixedDeal: r.payment.fixedDeal }); setNote(r.note); setRev(n => n + 1); }} /></ErrorBoundary>}
    {payment && <PaymentDialog dealId={payment.dealId} bookingId={payment.bookingId} initialAmount={payment.amount} fixedDeal={payment.fixedDeal} timezone={timezone} onClose={() => setPayment(null)} />}
    {picker && group && <TimelineResourcesPicker groups={chosen} groupId={group.id} resources={allResources} filter={filter} stops={current?.stops ?? []} loading={!current} onGroup={setGroupId} onFilter={ids => setFilters(prev => ({ ...prev, [group.id]: ids }))} onClose={() => setPicker(false)} />}
    {setup && <TimelineSetup groups={visible} value={chosen.map(g => g.id)} onClose={() => setSetup(false)} onSave={ids => { setSetup(false); onConfigure(ids.length === visible.length ? [] : ids); }} />}
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

/** Окно брони со шкалы: время, ресурсы, сделка и клиент (клиент — по сделке, правами сотрудника). */
function TimelineBooking({ booking, resources, timezone, onClose }: { booking: CalendarBooking; resources: Map<number, string>; timezone: string; onClose: () => void }) {
  const [client, setClient] = useState<ClientBookingsDto | null>(null);
  const [error, setError] = useState('');
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
  return createPortal(
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet timeline-booking" role="dialog" aria-modal="true" aria-label={`Бронь #${booking.id}`} onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Бронь #{booking.id}</h2>
          <button type="button" aria-label="Закрыть" onClick={onClose}>
            ×
          </button>
        </header>
        <dl className="timeline-booking-facts">
          <dt>Время</dt>
          <dd>
            {fmtDateTime(booking.start, timezone)} → {fmtDateTime(booking.end, timezone)}
          </dd>
          <dt>Ресурсы</dt>
          <dd>{booking.resourceIds.map((id) => resources.get(id) ?? `#${id}`).join(', ')}</dd>
          <dt>Сделка</dt>
          <dd>
            {booking.dealId ? (
              <button type="button" className="link" onClick={() => openCrm('deal', booking.dealId!)}>
                {booking.deal?.title ?? `Сделка #${booking.dealId}`}
                {booking.deal?.opportunity !== null && booking.deal?.opportunity !== undefined && ` · ${fmtMoney(booking.deal.opportunity, booking.deal.currency)}`}
              </button>
            ) : (
              <span className="muted">без сделки (служебная)</span>
            )}
          </dd>
          {booking.dealId && (
            <>
              <dt>Клиент</dt>
              <dd>
                {error ? (
                  <span className="muted">{error}</span>
                ) : !client ? (
                  <span className="muted">…</span>
                ) : contact ? (
                  <>
                    <button type="button" className="link" onClick={() => openCrm('contact', contact.id)}>
                      {contact.name || `Контакт #${contact.id}`}
                    </button>
                    {client.won.count > 0 && (
                      <span className="muted">
                        {' '}
                        · состоявшихся сделок: {client.won.count}
                        {client.won.avgCheck !== null && `, средний чек ${fmtMoney(client.won.avgCheck, client.won.currency)}`}
                      </span>
                    )}
                  </>
                ) : (
                  <span className="muted">контакта у сделки нет</span>
                )}
              </dd>
            </>
          )}
          {booking.fields
            .filter((f) => f.inView)
            .map((f) => (
              <FieldRow key={f.code} label={f.label} value={f.value} />
            ))}
        </dl>
        {booking.description && <p className="muted">{booking.description}</p>}
      </div>
    </div>,
    document.body,
  );
}

function FieldRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value || '—'}</dd>
    </>
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
