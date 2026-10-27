import { useEffect, useRef, useState } from 'react';
import type { ClientBookingsDto, DealBookingTone, MessengerClientContextDto } from '@btx24/shared';
import { apiGet, apiPut } from '../api.js';
import { pollEvery } from '../fresh-poll.js';
import { openCrm } from '../b24.js';
import { fmtDate, fmtDateTime, fmtMoney } from '../format.js';
import { Icon } from './icons.js';

const POLL_MS = 15_000;
const TONE_TITLES: Record<DealBookingTone, string> = {
  booked: 'По сделке уже есть бронь',
  filled: 'Брони нет, но в сделке заполнены поля брони',
  empty: 'По сделке брони нет',
};

type Deal = {
  id: number;
  title: string;
  opportunity: number | null;
  currency: string | null;
  createdAt: string | null;
  booking: { start: string; end: string; resources: string[] } | null;
  tone: DealBookingTone;
};

/** Сделки для карточки: из контекста своей линии и открытых сделок клиента (бронь, цвет, дата создания). */
export function chatDeals(ctx: MessengerClientContextDto | null, client: ClientBookingsDto | null, fallbackId: number | null): Deal[] {
  const open = new Map((client?.openDeals ?? []).map((d) => [d.id, d]));
  const base = ctx ? ctx.deals.filter((d) => d.active || d.id === ctx.activeDealId) : [...open.values()].map((d) => ({ id: d.id, title: d.title, opportunity: d.opportunity ?? null, currency: null }));
  const list = base.map((d): Deal => {
    const o = open.get(d.id);
    const booking = o?.booking ?? null;
    return { id: d.id, title: d.title, opportunity: d.opportunity ?? o?.opportunity ?? null, currency: d.currency ?? null, createdAt: o?.createdAt ?? null, booking, tone: o?.tone ?? (booking ? 'booked' : 'empty') };
  });
  if (fallbackId && !list.some((d) => d.id === fallbackId)) list.unshift({ id: fallbackId, title: `Сделка #${fallbackId}`, opportunity: null, currency: null, createdAt: null, booking: null, tone: 'empty' });
  return list;
}

/**
 * Сделка чата в шапке — одной строкой, как теги каналов: название (до 15 символов), сумма, дата брони
 * или создания сделки. Чат своей линии: ⇅ внутри блока — окно выбора сделки входящих сообщений
 * (если открытых несколько; в окне сделки — как в мастере брони).
 */
export function ChatDealCard({ chatId, dealId, appChat, timezone, extra }: { chatId: number; dealId: number | null; appChat: boolean; timezone: string; extra?: React.ReactNode }) {
  const [ctx, setCtx] = useState<{ id: number; v: MessengerClientContextDto } | null>(null);
  const [client, setClient] = useState<{ id: number; v: ClientBookingsDto } | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const load = () =>
      Promise.all([
        appChat ? apiGet<MessengerClientContextDto>(`/messengers/openlines/${chatId}/context`).then((v) => active && setCtx({ id: chatId, v }), () => undefined) : null,
        apiGet<ClientBookingsDto>(`/openlines/chats/${chatId}/bookings`).then((v) => active && setClient({ id: chatId, v }), () => undefined),
      ]);
    void load();
    const stop = pollEvery(load, POLL_MS);
    return () => {
      active = false;
      stop();
    };
  }, [chatId, appChat]);
  const context = ctx?.id === chatId ? ctx.v : null;
  const deals = chatDeals(context, client?.id === chatId ? client.v : null, dealId);
  const currentId = context?.activeDealId ?? dealId;
  const current = deals.find((d) => d.id === currentId) ?? null;
  const canChoose = appChat && !!context && deals.length > 1;

  const choose = async (id: number) => {
    try {
      const v = await apiPut<MessengerClientContextDto>(`/messengers/openlines/${chatId}/deal`, { dealId: id });
      setCtx({ id: chatId, v });
      setError('');
      setChoosing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось выбрать сделку');
    }
  };

  if (!current && !canChoose) return null;
  return (
    <div className="cv-deal-card">
      <span className="cv-deal-chip">
        {current ? (
          <button type="button" className="cv-deal-open" title={`${current.title} · #${current.id} — открыть сделку`} onClick={() => openCrm('deal', current.id)}>
            <b>{clipTitle(current.title)}</b>
            {current.opportunity ? <span>{fmtMoney(current.opportunity, current.currency)}</span> : null}
            {dealDate(current, timezone) && <span className="muted">{dealDate(current, timezone)}</span>}
          </button>
        ) : (
          <span className="cv-deal-pick">Выберите сделку</span>
        )}
        {canChoose && (
          <button type="button" className="cv-deal-switch" title="Изменить сделку входящих сообщений" aria-label="Изменить сделку" onClick={() => setChoosing(true)}>
            <Icon name="updown" size={14} />
          </button>
        )}
      </span>
      {extra}
      {context?.needsChoice && current && <span className="cv-deal-warn" title="У клиента несколько открытых сделок — проверьте, к какой относится обращение">!</span>}
      {choosing && <DealChooser deals={deals} currentId={currentId} timezone={timezone} error={error} onPick={(id) => void choose(id)} onClose={() => setChoosing(false)} />}
    </div>
  );
}

const TITLE_MAX = 15;
/** Название сделки в шапке — не длиннее 15 символов (полное — в подсказке). */
export function clipTitle(title: string): string {
  const t = title.trim();
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX).trimEnd()}…` : t;
}

/** Дата брони по сделке, без брони — дата создания сделки. */
export function dealDate(deal: Pick<Deal, 'booking' | 'createdAt'>, timezone: string): string | null {
  if (deal.booking) return `бронь ${fmtDate(deal.booking.start, timezone)}`;
  return deal.createdAt ? `от ${fmtDate(deal.createdAt, timezone)}` : null;
}

function DealTile({ deal, timezone, selected = true, onOpen }: { deal: Deal; timezone: string; selected?: boolean; onOpen: () => void }) {
  return (
    <button type="button" className={`bk-choice wz-deal cv-deal-tile tone-${deal.tone}${selected ? ' selected' : ''}`} title={`${TONE_TITLES[deal.tone]} · открыть сделку`} onClick={onOpen}>
      <span className="bk-dot" aria-hidden="true" />
      <span className="wz-deal-main">
        <b>{deal.title}</b>
        <span className="wz-deal-sub">
          {[deal.opportunity ? fmtMoney(deal.opportunity, deal.currency) : null, `#${deal.id}`, deal.createdAt ? `от ${fmtDate(deal.createdAt, timezone)}` : null].filter(Boolean).join(' · ')}
        </span>
        {deal.booking && (
          <span className="wz-deal-booking">
            Бронь: {fmtDateTime(deal.booking.start, timezone)}
            {deal.booking.resources.length ? ` · ${deal.booking.resources.join(', ')}` : ''}
          </span>
        )}
      </span>
    </button>
  );
}

function DealChooser({ deals, currentId, timezone, error, onPick, onClose }: { deals: Deal[]; currentId: number | null; timezone: string; error: string; onPick: (id: number) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => ref.current?.showModal(), []);
  return (
    <dialog ref={ref} className="new-dialog cv-deal-chooser" aria-label="Сделка входящих сообщений" onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <header className="new-dialog-head">
        <h3>Сделка входящих сообщений</h3>
        <button type="button" className="new-dialog-close" aria-label="Закрыть" onClick={onClose}>×</button>
      </header>
      <p className="muted">Новые сообщения клиента попадут в выбранную сделку.</p>
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="bk-choices cv-deal-options" role="radiogroup" aria-label="Сделка">
        {deals.map((d) => (
          <DealTile key={d.id} deal={d} timezone={timezone} selected={d.id === currentId} onOpen={() => onPick(d.id)} />
        ))}
      </div>
    </dialog>
  );
}
