import { useEffect, useState } from 'react';
import type { ClientBookingsDto } from '@btx24/shared';
import { openCrm } from '../b24.js';
import { fmtDateTime } from '../format.js';
import { DealStatusBadge } from '../openlines/DealStatusBadge.js';

/** Сначала визит сейчас, затем ближайшие брони и остальные открытые сделки клиента. */
export function ClientSituation({ client, timezone }: { client: ClientBookingsDto | null; timezone: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60000); return () => clearInterval(timer); }, []);
  if (!client) return null;
  const bookings = client.upcoming.filter((b) => Date.parse(b.end) > now).sort((a,b) => Date.parse(a.start) - Date.parse(b.start));
  const booked = new Set(bookings.map((b) => b.dealId));
  const deals = client.openDeals.filter((d) => !booked.has(d.id));
  return <section className="call-situation" aria-label="Текущие и будущие брони и сделки">
    <h4>Текущие и будущие</h4>
    {!bookings.length && !deals.length && <p className="muted">Текущих и будущих броней, открытых сделок нет.</p>}
    {bookings.map((b,i) => {
      const deal = client.openDeals.find((d) => d.id === b.dealId);
      const active = Date.parse(b.start) <= now;
      return <div key={`${b.bookingId}:${i}`} className={`call-situation-row${active ? ' active' : ''}`}>
        <div><b>{active ? 'Сейчас' : 'Предстоит'} · {b.resources.join(', ') || 'Бронирование'}</b><span className="muted">{fmtDateTime(b.start, timezone)} — {fmtDateTime(b.end, timezone)}</span></div>
        {deal?.status && <DealStatusBadge s={active && deal.status.status === 'waiting' ? { ...deal.status, status: 'arrived' } : deal.status} />}
        {b.dealId && <button type="button" className="link" onClick={() => openCrm('deal', b.dealId!)}>{deal?.title || b.deal?.title || `Сделка #${b.dealId}`}</button>}
      </div>;
    })}
    {deals.map((d) => <div key={d.id} className="call-situation-row"><button type="button" className="link" onClick={() => openCrm('deal', d.id)}>{d.title}</button><DealStatusBadge s={d.status} /></div>)}
  </section>;
}
