import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BookingInfoDto, LiveBookingDto, LiveBookingsDto, LiveBookingsKind } from '@btx24/shared';
import { apiGet } from '../api.js';
import { openCrm } from '../b24.js';
import { fmtDateTime, fmtMoney, fmtTime } from '../format.js';
import { dayKey } from '../openlines/chat-list.js';
import { Avatar } from '../openlines/Avatar.js';
import { DashBadge } from '../openlines/RecentCalls.js';
import { BlockLoading } from './BlockLoading.js';
import { useDashboardQuery } from './DashboardSync.js';

const TITLES: Record<LiveBookingsKind, string> = { upcoming: 'Ближайшие брони', current: 'Текущие брони' };
const EMPTY: Record<LiveBookingsKind, string> = { upcoming: 'Ближайших броней нет (14 дней).', current: 'Сейчас броней нет.' };

/** Начало брони: сегодня — время, иначе дата и время; у текущей — «до» окончания. */
export function liveBookingWhen(b: Pick<LiveBookingDto, 'start' | 'end'>, kind: LiveBookingsKind, timezone: string, now = new Date()): string {
  const at = kind === 'current' ? b.end : b.start;
  const today = dayKey(now.toISOString(), timezone) === dayKey(at, timezone);
  const text = today ? fmtTime(at, timezone) : fmtDateTime(at, timezone);
  return kind === 'current' ? `до ${text}` : text;
}

/** Оплата: «оплачено 5 000 ₽ из 12 000 ₽»; полная оплата — отдельным тоном. */
export function paidTone(b: Pick<LiveBookingDto, 'amount' | 'paid'>): 'full' | 'part' | 'none' | null {
  if (b.paid === null) return null;
  if (b.paid <= 0) return 'none';
  return b.amount !== null && b.paid >= b.amount ? 'full' : 'part';
}

/** «Ближайшие брони» / «Текущие брони»: строка — название, время, ресурс, клиент, сумма и оплата; по клику — карточка. */
export function LiveBookingsBlock({ kind, timezone }: { kind: LiveBookingsKind; timezone: string }) {
  const { data, error } = useDashboardQuery<LiveBookingsDto>(`/dashboard/live-bookings?kind=${kind}`, undefined, 60_000);
  const [open, setOpen] = useState<LiveBookingDto | null>(null);
  return (
    <section className="day-panel dash-block dash-live-bookings">
      <DashBadge name="calendar" />
      <p className="dash-attention-title muted">
        {TITLES[kind]}
        {!!data?.items.length && <span className="pill">{data.items.length}</span>}
      </p>
      {error && <p className="muted">{error}</p>}
      {!data && !error && <BlockLoading rows={3} />}
      {data && !data.items.length && <p className="muted">{EMPTY[kind]}</p>}
      <ul className="live-booking-list">
        {data?.items.map((b) => {
          const tone = paidTone(b);
          return (
            <li key={b.bookingId}>
              <button type="button" className={`live-booking${b.pendingRemoval ? ' removed' : ''}`} onClick={() => setOpen(b)} title={`${fmtDateTime(b.start, timezone)} → ${fmtDateTime(b.end, timezone)}`}>
                <span className="live-booking-title">{b.title}</span>
                <span className="live-booking-time">{liveBookingWhen(b, kind, timezone)}</span>
                <span className="live-booking-resource">{b.resources.join(', ')}</span>
                <span className="live-booking-client">
                  {b.client ? (
                    <>
                      <Avatar src={b.client.photo} name={b.client.name} size={22} />
                      <span>{b.client.name}</span>
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </span>
                <span className="live-booking-amount">{b.amount !== null ? fmtMoney(b.amount, b.currency) : ''}</span>
                <span className={`live-booking-paid${tone ? ` ${tone}` : ''}`}>{b.paid !== null ? fmtMoney(b.paid, b.currency) : ''}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {open && <BookingInfoSheet bookingId={open.bookingId} timezone={timezone} onClose={() => setOpen(null)} />}
    </section>
  );
}

/** Карточка брони: время, ресурсы, сделка (стадия, сумма, оплата, ответственный), клиент, поля группы и товары. */
export function BookingInfoSheet({ bookingId, timezone, onClose }: { bookingId: number; timezone: string; onClose: () => void }) {
  const [info, setInfo] = useState<BookingInfoDto | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    apiGet<BookingInfoDto>(`/bookings/${bookingId}/info`).then(
      (r) => active && setInfo(r),
      (e) => active && setError(e instanceof Error ? e.message : 'Не удалось загрузить бронь'),
    );
    return () => void (active = false);
  }, [bookingId]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  const deal = info?.deal ?? null;
  const client = info?.client ?? null;
  const total = info?.products.reduce((s, p) => s + p.sum, 0) ?? 0;
  return createPortal(
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet timeline-booking booking-info" role="dialog" aria-modal="true" aria-label={`Бронь #${bookingId}`} onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{deal?.title ?? info?.booking.title ?? `Бронь #${bookingId}`}</h2>
          <button type="button" aria-label="Закрыть" onClick={onClose}>
            ×
          </button>
        </header>
        {error && <p className="notice error">{error}</p>}
        {!info && !error && <BlockLoading rows={4} />}
        {info && (
          <>
            {client && (
              <div className="booking-info-client">
                <Avatar src={client.photo} name={client.name} size={40} />
                <span>
                  <button type="button" className="link" onClick={() => openCrm('contact', client.id)}>
                    {client.name}
                  </button>
                  {!!client.phones.length && <span className="muted"> · {client.phones.join(', ')}</span>}
                </span>
              </div>
            )}
            <dl className="timeline-booking-facts">
              <dt>Время</dt>
              <dd>
                {fmtDateTime(info.booking.start, timezone)} → {fmtDateTime(info.booking.end, timezone)}
              </dd>
              <dt>Ресурсы</dt>
              <dd>{info.booking.resources.join(', ')}</dd>
              {info.booking.status === 'cancelled' && (
                <>
                  <dt>Статус</dt>
                  <dd>отменена</dd>
                </>
              )}
              <dt>Сделка</dt>
              <dd>
                {deal ? (
                  <button type="button" className="link" onClick={() => openCrm('deal', deal.id)}>
                    #{deal.id}
                    {deal.stage && ` · ${deal.stage}`}
                  </button>
                ) : (
                  <span className="muted">нет или нет доступа</span>
                )}
              </dd>
              {deal?.amount !== null && deal?.amount !== undefined && (
                <>
                  <dt>Сумма</dt>
                  <dd>{fmtMoney(deal.amount, deal.currency)}</dd>
                </>
              )}
              {deal?.paid !== null && deal?.paid !== undefined && (
                <>
                  <dt>Оплачено</dt>
                  <dd>{fmtMoney(deal.paid, deal.currency)}</dd>
                </>
              )}
              {deal?.assigned && (
                <>
                  <dt>Ответственный</dt>
                  <dd>{deal.assigned}</dd>
                </>
              )}
              {info.fields.map((f) => (
                <FieldRow key={f.code} label={f.label} value={f.value} />
              ))}
            </dl>
            {!!info.products.length && (
              <table className="booking-info-products">
                <thead>
                  <tr>
                    <th>Товар</th>
                    <th>Кол-во</th>
                    <th>Сумма</th>
                  </tr>
                </thead>
                <tbody>
                  {info.products.map((p, i) => (
                    <tr key={i}>
                      <td>{p.name}</td>
                      <td>{p.quantity}</td>
                      <td>{fmtMoney(p.sum, deal?.currency ?? null)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={2}>Итого</td>
                    <td>{fmtMoney(Math.round(total * 100) / 100, deal?.currency ?? null)}</td>
                  </tr>
                </tfoot>
              </table>
            )}
          </>
        )}
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
