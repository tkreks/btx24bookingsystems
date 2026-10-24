import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { todayIn, zonedDayRange, type CalendarBooking, type CalendarDay, type CalendarTechWindow, type ClientBookingsDto, type MyGroupDto } from '@btx24/shared';
import { apiGet } from '../api.js';
import { openCrm } from '../b24.js';
import { BookingForm, type WizardResult } from '../bookings/BookingForm.js';
import { PaymentDialog } from '../bookings/PaymentDialog.js';
import { availabilityPieces, SLOT_MINUTES } from '../calendar/layout.js';
import { ErrorBoundary } from '../ErrorBoundary.js';
import { fmtDateTime, fmtMoney, fmtTime } from '../format.js';
import { dayKey } from '../openlines/chat-list.js';
import { DashBadge } from '../openlines/RecentCalls.js';

/** Не больше недели вперёд: дальше шкала нечитаема, а запросов по дню слишком много. */
const MAX_DAYS = 7;
const POLL_MS = 60_000;

interface Timeline {
  key: string;
  startMs: number;
  endMs: number;
  days: CalendarDay[];
  bookings: CalendarBooking[];
  techWindows: CalendarTechWindow[];
}

/** Дни портала от сегодня до `to` включительно (не больше недели); прошедший период — только сегодня. */
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

/**
 * «Брони сегодня (шкала)»: ресурсы одной группы — шкала занятости от текущего момента до конца
 * выбранного периода (не дальше недели). Зелёное — свободно (тех. окно бронь не запрещает), красное —
 * бронь: по ней — окно с бронью, сделкой и клиентом; по свободному — мастер брони с выбора клиента.
 * Какие группы есть в выборе — ⚙ в блоке (у каждого сотрудника своё).
 */
export function ResourceTimelineBlock({
  groups,
  config,
  to,
  timezone,
  onConfigure,
}: {
  groups: MyGroupDto[];
  config: string[] | undefined;
  /** Последний день периода дашборда. */
  to: string;
  timezone: string;
  onConfigure: (groupIds: string[]) => void;
}) {
  const visible = groups.filter((g) => g.permissions.includes('calendar.view'));
  const chosen = config?.length ? visible.filter((g) => config.includes(g.id)) : visible;
  const [groupId, setGroupId] = useState<string>('');
  const group = chosen.find((g) => g.id === groupId) ?? chosen[0] ?? null;
  const [data, setData] = useState<Timeline | null>(null);
  const [error, setError] = useState('');
  const [rev, setRev] = useState(0);
  const [selected, setSelected] = useState<CalendarBooking | null>(null);
  const [form, setForm] = useState<{ date: string; time: string; resourceId: number } | null>(null);
  const [payment, setPayment] = useState<{ dealId: number; bookingId: number | null; amount?: number | null; fixedDeal?: boolean } | null>(null);
  const [note, setNote] = useState('');
  const [setup, setSetup] = useState(false);
  const canCreate = !!group?.permissions.includes('booking.create');
  const canPay = groups.some((g) => g.permissions.includes('payment.send'));
  const days = timelineDays(todayIn(timezone), to);
  const key = `${group?.id ?? ''}|${days.join(',')}`;

  useEffect(() => {
    if (!group) return;
    let active = true;
    const load = () =>
      Promise.all(days.map((date) => apiGet<CalendarDay>(`/calendar?date=${date}&groupId=${encodeURIComponent(group.id)}`))).then(
        (list) => {
          if (!active) return;
          // Бронь на несколько дней приходит в каждом из них — оставляем одну.
          const bookings = [...new Map(list.flatMap((x) => x.bookings).map((b) => [b.id, b])).values()];
          const techWindows = [...new Map(list.flatMap((x) => x.techWindows).map((t) => [`${t.resourceId}:${t.start}`, t])).values()];
          setData({ key, startMs: Date.now(), endMs: zonedDayRange(days[days.length - 1], timezone).end.getTime(), days: list, bookings, techWindows });
          setError('');
        },
        (e) => active && setError(e instanceof Error ? e.message : 'Не удалось загрузить брони'),
      );
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
    // `days` выражен ключом.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, timezone, rev]);

  const current = data?.key === key ? data : null;
  const resources = current?.days[0]?.resources ?? [];
  const span = current ? current.endMs - current.startMs : 1;
  // Деления шкалы — полночи дней портала.
  const ticks = current ? days.slice(1).map((date) => ({ date, at: (zonedDayRange(date, timezone).start.getTime() - current.startMs) / span })) : [];

  // Клик по свободному месту → получас (не раньше начала свободного куска и не в прошлом).
  const createAt = (resourceId: number, fraction: number, notBefore: number) => {
    if (!current) return;
    const slot = SLOT_MINUTES * 60_000;
    const at = current.startMs + fraction * span;
    const start = Math.max(Math.floor(at / slot) * slot, Math.ceil(notBefore / slot) * slot);
    const iso = new Date(start).toISOString();
    setNote('');
    setForm({ date: dayKey(iso, timezone), time: fmtTime(iso, timezone), resourceId });
  };

  return (
    <section className="day-panel dash-block dash-timeline">
      <DashBadge name="calendar" />
      <p className="dash-attention-title muted">
        Брони сегодня
        {chosen.length > 1 ? (
          <select className="dash-timeline-group" aria-label="Группа" value={group?.id ?? ''} onChange={(e) => setGroupId(e.target.value)}>
            {chosen.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        ) : (
          group && <span className="dash-timeline-name">{group.name}</span>
        )}
        {visible.length > 1 && (
          <button type="button" className="dash-kpi-setup" aria-label="Выбрать группы шкалы" title="Какие группы показывать" onClick={() => setSetup(true)}>
            ⚙
          </button>
        )}
      </p>
      {!visible.length && <p className="muted">Нет групп с календарём.</p>}
      {error && <p className="notice error" role="alert">{error}</p>}
      {note && <p className="notice">{note}</p>}
      {group && !current && !error && <p className="muted">Загружаем брони…</p>}
      {current && !resources.length && <p className="muted">В группе нет ресурсов.</p>}
      {current && !!resources.length && (
        <div className="timeline-rows">
          <div className="timeline-axis" aria-hidden="true">
            <span className="timeline-now">сейчас {fmtTime(new Date(current.startMs).toISOString(), timezone)}</span>
            {ticks.map((t) => (
              <span key={t.date} className="timeline-tick" style={{ left: `${t.at * 100}%` }}>
                {t.date.slice(8, 10)}.{t.date.slice(5, 7)}
              </span>
            ))}
            <span className="timeline-end">{days.length > 1 ? `до ${days[days.length - 1].slice(8, 10)}.${days[days.length - 1].slice(5, 7)} 24:00` : '24:00'}</span>
          </div>
          {resources.map((r) => {
            const pieces = availabilityPieces(current.bookings, current.techWindows, r.id, current.startMs, current.endMs);
            return (
              <div key={r.id} className="timeline-row">
                <span className="timeline-resource" title={`${r.name} #${r.id}`}>
                  {r.name}
                </span>
                <div className="timeline-bar" role="group" aria-label={`Занятость: ${r.name}`}>
                  {ticks.map((t) => (
                    <i key={t.date} className="timeline-midnight" style={{ left: `${t.at * 100}%` }} aria-hidden="true" />
                  ))}
                  {pieces.map((p, i) => {
                    const style = { left: `${p.from * 100}%`, width: `${(p.to - p.from) * 100}%` };
                    const booking = p.kind === 'booked' && p.bookingId !== null ? current.bookings.find((b) => b.id === p.bookingId) : undefined;
                    if (booking)
                      return (
                        <button
                          key={i}
                          type="button"
                          className="tl-piece busy"
                          style={style}
                          title={`${fmtDateTime(booking.start, timezone)} → ${fmtDateTime(booking.end, timezone)}${booking.deal ? ` · ${booking.deal.title}` : ''}`}
                          aria-label={`Бронь ${fmtDateTime(booking.start, timezone)} — ${fmtDateTime(booking.end, timezone)}`}
                          onClick={() => setSelected(booking)}
                        >
                          {p.to - p.from >= 0.08 && <span>{fmtTime(booking.start, timezone)}–{fmtTime(booking.end, timezone)}</span>}
                        </button>
                      );
                    const from = current.startMs + p.from * span;
                    return canCreate ? (
                      <button
                        key={i}
                        type="button"
                        className="tl-piece free"
                        style={style}
                        title={p.kind === 'tech' ? 'Тех. окно — бронь возможна · нажмите, чтобы забронировать' : 'Свободно · нажмите, чтобы забронировать'}
                        aria-label={`Забронировать ${r.name}`}
                        onClick={(e) => {
                          const bar = e.currentTarget.parentElement!.getBoundingClientRect();
                          createAt(r.id, (e.clientX - bar.left) / bar.width, from);
                        }}
                      />
                    ) : (
                      <div key={i} className="tl-piece free" style={style} title="Свободно" />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {selected && <TimelineBooking booking={selected} resources={new Map(resources.map((r) => [r.id, r.name]))} timezone={timezone} onClose={() => setSelected(null)} />}
      {form && group && (
        <ErrorBoundary where="booking-form" onClose={() => setForm(null)}>
          <BookingForm
            groups={groups}
            timezone={timezone}
            context={{ ...form, groupId: group.id }}
            onClose={() => setForm(null)}
            onDone={(r: WizardResult) => {
              setForm(null);
              if (r.payment && r.dealId && canPay) setPayment({ dealId: r.dealId, bookingId: r.booking?.bookingId ?? null, amount: r.payment.amount, fixedDeal: r.payment.fixedDeal });
              setNote(r.note);
              setRev((n) => n + 1);
            }}
          />
        </ErrorBoundary>
      )}
      {payment && (
        <PaymentDialog
          dealId={payment.dealId}
          bookingId={payment.bookingId}
          initialAmount={payment.amount}
          fixedDeal={payment.fixedDeal}
          timezone={timezone}
          onClose={() => setPayment(null)}
        />
      )}
      {setup && (
        <TimelineSetup
          groups={visible}
          value={chosen.map((g) => g.id)}
          onClose={() => setSetup(false)}
          onSave={(ids) => {
            setSetup(false);
            // Выбраны все — храним пусто: новые группы сотрудника появятся сами.
            onConfigure(ids.length === visible.length ? [] : ids);
          }}
        />
      )}
    </section>
  );
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
