import { useEffect, useState } from 'react';
import { DEAL_TONE_LABELS, type CallCardDto, type ClientBookingDto, type ClientBookingsDto } from '@btx24/shared';
import { apiGet } from '../api.js';
import { openCrm } from '../b24.js';
import { fmtDate, fmtDateTime, fmtMoney, fmtTime } from '../format.js';
import { dayKey } from '../openlines/chat-list.js';
import { Channel } from '../openlines/Channel.js';
import { DealStatusBadge } from '../openlines/DealStatusBadge.js';

/** Что известно о звонке: из окна звонка Битрикс24 (встройка) или из события ответа. */
export interface CallRef {
  callId?: string | null;
  phone?: string | null;
  entityType?: string | null;
  entityId?: string | number | null;
}

/**
 * Карточка звонка (решение владельца 2026-10-23): клиент и его теги, сделки в работе цветом для новой
 * брони (🔴 есть бронь, 🟠 брони нет, но остались поля брони, 🟢 пустая), брони, последние сообщения из
 * чатов. «Создать бронь» — мастер с выбранным клиентом и предложенной сделкой.
 */
export function CallCard({
  call,
  timezone,
  onCreate,
  canCreate,
}: {
  call: CallRef;
  timezone: string;
  canCreate: boolean;
  onCreate: (card: CallCardDto) => void;
}) {
  const [card, setCard] = useState<CallCardDto | null>(null);
  const [error, setError] = useState('');
  const key = JSON.stringify(call);
  useEffect(() => {
    let active = true;
    const c = JSON.parse(key) as CallRef;
    const q = new URLSearchParams(
      Object.entries({ callId: c.callId, phone: c.phone, entityType: c.entityType, entityId: c.entityId }).flatMap(([k, v]) => (v ? [[k, String(v)]] : [])),
    );
    apiGet<CallCardDto>(`/calls/card?${q}`).then(
      (d) => active && setCard(d),
      (e) => active && setError(e instanceof Error ? e.message : 'Не удалось загрузить клиента'),
    );
    return () => {
      active = false;
    };
  }, [key]);

  if (error) return <p className="notice error">{error}</p>;
  if (!card) return <p className="muted">Ищем клиента{call.phone ? ` по номеру ${call.phone}` : ''}…</p>;
  const c = card.client;
  const deals = [...(c?.openDeals ?? [])].sort((a, b) => Number(b.id === card.suggestedDealId) - Number(a.id === card.suggestedDealId) || b.id - a.id);

  return (
    <div className="call-card">
      <div className="call-head">
        <div>
          <b className="call-client">{card.contact?.name || (card.contact ? `Контакт #${card.contact.id}` : 'Клиент не найден в CRM')}</b>
          <span className="muted">{card.phone ?? ''}</span>
        </div>
        {canCreate && (
          <button className="primary" onClick={() => onCreate(card)}>
            + Создать бронь
          </button>
        )}
      </div>
      {c && (
        <div className="cb-stats">
          <span className="cb-tag" title="Успешные сделки клиента">
            Сделок <b>{c.won.count}</b>
          </span>
          {c.won.avgCheck !== null && (
            <span className="cb-tag">
              Ср. чек <b>{fmtMoney(c.won.avgCheck, c.won.currency)}</b>
            </span>
          )}
          <span className="cb-tag">
            Броней было <b>{c.past}</b>
          </span>
          {card.contact && (
            <button className="link" onClick={() => openCrm('contact', card.contact!.id)}>
              Контакт в CRM
            </button>
          )}
        </div>
      )}

      <section className="call-section">
        <h4>Сделки в работе</h4>
        {!deals.length && <p className="muted">Открытых сделок нет — при брони создастся новая.</p>}
        <ul className="call-deals">
          {deals.map((d) => (
            <li key={d.id} className={`call-deal tone-${d.tone ?? 'empty'}`} title={d.tone ? DEAL_TONE_LABELS[d.tone] : undefined}>
              <span className="call-deal-dot" aria-hidden="true" />
              <span className="call-deal-main">
                <button className="link" onClick={() => openCrm('deal', d.id)}>
                  {d.title}
                </button>
                <span className="muted">
                  #{d.id}
                  {d.createdAt ? ` · от ${fmtDate(d.createdAt, timezone)}` : ''}
                  {d.opportunity ? ` · ${fmtMoney(d.opportunity, 'RUB')}` : ''}
                  {d.id === card.suggestedDealId ? ' · для брони' : ''}
                </span>
                {d.booking && (
                  <span className="muted">
                    Бронь: {fmtDateTime(d.booking.start, timezone)}
                    {d.booking.resources.length ? ` · ${d.booking.resources.join(', ')}` : ''}
                  </span>
                )}
              </span>
              <DealStatusBadge s={d.status} />
            </li>
          ))}
        </ul>
      </section>

      {c && (c.upcoming.length > 0 || c.recent.length > 0) && (
        <section className="call-section">
          <h4>Брони</h4>
          <ul className="call-bookings">
            {[...c.upcoming, ...c.recent].slice(0, 6).map((b, i) => (
              <li key={`${b.bookingId ?? 'f'}:${i}`} className={`cb-row ${b.when}`}>
                <span>
                  <b>{bookingRange(b, timezone)}</b> {b.resources.join(', ')}
                </span>
                <span className="muted">{b.deal?.title ?? (b.dealId ? `Сделка #${b.dealId}` : '')}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {card.messages && (
        <section className="call-section">
          <h4>
            Последние сообщения
            {card.chats[0] && (
              <span className="call-channel">
                <Channel connector={card.chats.find((x) => x.chatId === card.messages!.chatId)?.connector ?? ''} />
              </span>
            )}
          </h4>
          <ul className="call-messages">
            {card.messages.items.map((m) => (
              <li key={m.id} className={m.author.kind === 'client' ? 'in' : 'out'}>
                <span className="muted">
                  {m.author.kind === 'client' ? 'Клиент' : m.author.name} · {fmtDateTime(m.date, timezone)}
                </span>
                <span>{m.text || (m.files.length ? '📎 Файл' : '')}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function bookingRange(b: ClientBookingDto, tz: string): string {
  return dayKey(b.start, tz) === dayKey(b.end, tz) ? `${fmtDateTime(b.start, tz)}–${fmtTime(b.end, tz)}` : `${fmtDateTime(b.start, tz)} – ${fmtDateTime(b.end, tz)}`;
}

/** Контекст мастера брони из карточки звонка: клиент выбран, сделки клиента с цветом, предложенная — первой. */
export function bookingContextFromCard(card: CallCardDto, date: string) {
  const c: ClientBookingsDto | null = card.client;
  return {
    date,
    contactId: card.contact?.id ?? null,
    clientName: card.contact?.name ?? null,
    openDeals: c?.openDeals ?? [],
    selectDealId: card.suggestedDealId,
  };
}
