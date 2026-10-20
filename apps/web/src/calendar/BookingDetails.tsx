import type { CalendarBooking, CalendarDay } from '@btx24/shared';
import { fmtDateTime, fmtMoney } from '../format.js';

export function BookingDetails({ booking, day, onClose }: { booking: CalendarBooking; day: CalendarDay; onClose: () => void }) {
  const names = new Map(day.resources.map((r) => [r.id, r.name]));
  const openDeal = () => {
    if (booking.dealId) window.BX24?.openPath?.(`/crm/deal/details/${booking.dealId}/`);
  };
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{booking.name || 'Бронь'}</h2>
          <button aria-label="Закрыть" onClick={onClose}>×</button>
        </header>
        <dl>
          <dt>Время</dt>
          <dd>{fmtDateTime(booking.start, day.timezone)} — {fmtDateTime(booking.end, day.timezone)}</dd>
          <dt>Ресурс</dt>
          <dd>{booking.resourceIds.map((id) => names.get(id) ?? `#${id}`).join(', ')}</dd>
          {booking.description && (
            <>
              <dt>Описание</dt>
              <dd>{booking.description}</dd>
            </>
          )}
          <dt>Сделка</dt>
          <dd>
            {booking.deal ? (
              <>
                <button className="link" onClick={openDeal}>#{booking.deal.id} {booking.deal.title}</button>
                {booking.deal.opportunity ? <div className="muted">{fmtMoney(booking.deal.opportunity, booking.deal.currency)}</div> : null}
              </>
            ) : booking.dealId ? (
              <span className="muted">#{booking.dealId} — нет доступа к сделке</span>
            ) : (
              <span className="muted">не привязана</span>
            )}
          </dd>
        </dl>
      </div>
    </div>
  );
}
