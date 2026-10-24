import { useEffect, useRef, useState } from 'react';
import type { CallCardDto, ClientBookingDto, ClientBookingsDto } from '@btx24/shared';
import { apiGet } from '../api.js';
import { openCrm } from '../b24.js';
import { fmtDateTime, fmtMoney, fmtTime } from '../format.js';
import { dayKey } from '../openlines/chat-list.js';
import { MessengerSearchDialog } from '../messengers/MessengerSearchDialog.js';
import { ClientSituation } from './ClientSituation.js';
import { ClientTimeline } from './ClientTimeline.js';

export interface CallRef {
  callId?: string | null;
  phone?: string | null;
  entityType?: string | null;
  entityId?: string | number | null;
}


/** Клиент звонка: контакт и показатели сверху, единая история взаимодействий ниже. */
export function CallCard({ call, timezone, onCreate, canCreate }: {
  call: CallRef; timezone: string; canCreate: boolean; onCreate: (card: CallCardDto) => void;
}) {
  const [card, setCard] = useState<CallCardDto | null>(null);
  const [error, setError] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [bookingsOpen, setBookingsOpen] = useState(false);
  const [shown, setShown] = useState(25);
  const key = JSON.stringify(call);
  useEffect(() => {
    let active = true;
    const c = JSON.parse(key) as CallRef;
    const q = new URLSearchParams(Object.entries({ callId: c.callId, phone: c.phone, entityType: c.entityType, entityId: c.entityId }).flatMap(([k, v]) => v ? [[k, String(v)]] : []));
    apiGet<CallCardDto>(`/calls/card?${q}`).then(
      (d) => { if (active) { setCard(d); setError(''); setShown(25); setBookingsOpen(false); } },
      (e) => active && setError(e instanceof Error ? e.message : 'Не удалось загрузить клиента'),
    );
    return () => { active = false; };
  }, [key]);
  if (error) return <p className="notice error">{error}</p>;
  if (!card) return <p className="muted">Ищем клиента{call.phone ? ` по номеру ${call.phone}` : ''}…</p>;
  const c = card.client;
  const events = [...(card.timeline?.events ?? [])].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return <div className="call-card">
    <div className="call-client-summary">
      <b className="call-client">{card.contact?.name || (card.contact ? `Контакт #${card.contact.id}` : 'Клиент не найден в CRM')}</b>
      <span className="call-phone">{card.phone || 'Телефон не указан'}</span>
      <div className="cb-stats">
        <button type="button" className="cb-tag" disabled={!c} onClick={() => setBookingsOpen(true)} aria-label={`Броней было: ${c?.past ?? '—'}`}>Броней было <b>{c?.past ?? '—'}</b></button>
        <span className="cb-tag">Средний чек <b>{c?.won.avgCheck != null ? fmtMoney(c.won.avgCheck, c.won.currency) : '—'}</b></span>
      </div>
      <div className="call-client-actions">
        <button type="button" disabled={!card.contact} onClick={() => card.contact && openCrm('contact', card.contact.id)}>Открыть контакт</button>
        <button type="button" disabled={!c} onClick={() => setBookingsOpen(true)}>Список броней</button>
        {!card.chats.length && card.phone && <button type="button" onClick={() => setSearchOpen(true)}>Поиск в мессенджерах</button>}
        {canCreate && <button type="button" className="primary" onClick={() => onCreate(card)}>+ Создать бронь</button>}
      </div>
    </div>
    <ClientSituation client={c} timezone={timezone} />
    <section className="call-section" aria-label="История общения">
      <h4>История общения</h4>
      {!events.length && <p className="muted">Доступных событий пока нет.</p>}
      <ClientTimeline events={events.slice(0, shown)} timezone={timezone} />

      {events.length > 25 && <button type="button" className="list-more" onClick={() => setShown(shown < events.length ? shown + 25 : 25)}>{shown < events.length ? `Показать ещё · ${Math.min(shown, events.length)} из ${events.length}` : 'Свернуть'}</button>}
      {!!card.timeline?.notes.length && <details className="client-timeline-notes"><summary>Об истории событий</summary>{card.timeline.notes.map((n) => <p key={n}>{n}</p>)}</details>}
    </section>
    {searchOpen && card.phone && <MessengerSearchDialog phone={card.phone} timezone={timezone} onClose={() => setSearchOpen(false)} />}
    {bookingsOpen && c && <CallBookingsDialog data={c} timezone={timezone} onClose={() => setBookingsOpen(false)} />}
  </div>;
}

function CallBookingsDialog({ data, timezone, onClose }: { data: ClientBookingsDto; timezone: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  const groups = [{ title: 'Текущие и будущие', items: data.upcoming }, { title: 'Прошедшие', items: data.history ?? data.recent }];
  return <dialog ref={ref} className="call-bookings-dialog" aria-label="Брони клиента" onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => e.stopPropagation()}>
    <header><h3>Брони клиента</h3><button type="button" aria-label="Закрыть список броней" onClick={onClose}>×</button></header>
    {groups.map(({ title, items }) => items.length > 0 && <section key={title}><h4>{title} · {items.length}</h4><ul className="call-bookings">
      {items.map((b, i) => <li key={`${b.bookingId ?? b.dealId}:${i}`} className={`cb-row ${b.when}`}>
        <div><b>{bookingRange(b, timezone)}</b><div>{b.resources.join(', ')}</div>{b.deal && <span className="muted">{b.deal.title}</span>}</div>
        {b.dealId && <button type="button" className="link" onClick={() => openCrm('deal', b.dealId!)}>Сделка #{b.dealId}</button>}
      </li>)}
    </ul></section>)}
    {!groups.some((g) => g.items.length) && <p className="muted">Броней не найдено.</p>}
  </dialog>;
}
function bookingRange(b: ClientBookingDto, tz: string): string {
  return dayKey(b.start, tz) === dayKey(b.end, tz) ? `${fmtDateTime(b.start, tz)}–${fmtTime(b.end, tz)}` : `${fmtDateTime(b.start, tz)} – ${fmtDateTime(b.end, tz)}`;
}
export function bookingContextFromCard(card: CallCardDto, date: string) {
  const c: ClientBookingsDto | null = card.client;
  return { date, contactId: card.contact?.id ?? null, clientName: card.contact?.name ?? null, openDeals: c?.openDeals ?? [], selectDealId: card.suggestedDealId };
}
