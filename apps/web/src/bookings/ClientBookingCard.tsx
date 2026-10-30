import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { ClientBookingDto } from '@btx24/shared';
import { openCrm } from '../b24.js';
import { fmtDateTime, fmtMoney, fmtTime } from '../format.js';
import { dayKey } from '../openlines/chat-list.js';
import { Icon } from '../openlines/icons.js';

/** Статус брони для пилюли: исход сделки важнее времени (проиграна — даже если бронь впереди). */
export function bookingStatus(b: ClientBookingDto): { tone: 'now' | 'future' | 'past' | 'won' | 'lost'; label: string } {
  if (b.deal?.stageSemantic === 'F') return { tone: 'lost', label: 'Сделка проиграна' };
  if (b.when === 'now') return { tone: 'now', label: 'Идёт сейчас' };
  if (b.when === 'future') return { tone: 'future', label: 'Впереди' };
  if (b.deal?.stageSemantic === 'S') return { tone: 'won', label: 'Прошла · выиграна' };
  return { tone: 'past', label: 'Прошла' };
}

export function bookingRangeText(b: ClientBookingDto, tz: string): string {
  return dayKey(b.start, tz) === dayKey(b.end, tz)
    ? `${fmtDateTime(b.start, tz)}–${fmtTime(b.end, tz)}`
    : `${fmtDateTime(b.start, tz)} – ${fmtDateTime(b.end, tz)}`;
}

/**
 * Компактная карточка брони клиента (чат): одна для текущих/будущих и прошедших — различается только
 * статус. Сделка (название, сумма), ресурсы, начало–конец в поясе портала, «Открыть сделку», «В календаре».
 */
export function ClientBookingCard({ b, tz, onOpenDay }: { b: ClientBookingDto; tz: string; onOpenDay?: (date: string) => void }) {
  const status = bookingStatus(b);
  const title = b.deal?.title || (b.dealId ? `Сделка #${b.dealId}` : b.bookingId ? `Бронь #${b.bookingId}` : 'Бронь');
  const sum = b.deal?.opportunity ? fmtMoney(b.deal.opportunity, 'RUB') : null;
  return (
    <article className={`cbk-card ${status.tone}`} aria-label={`${title}: ${bookingRangeText(b, tz)}`}>
      <b className="cbk-title" title={title}>
        {title}
      </b>
      <span className="cbk-sum">{sum}</span>
      <div className="cbk-sub">
        <span className={`cbk-status ${status.tone}`}>{status.label}</span>
        <span className="cbk-when">{bookingRangeText(b, tz)}</span>
        {b.resources.length > 0 && (
          <span className="cbk-res" title={b.resources.join(', ')}>
            {b.resources.join(', ')}
          </span>
        )}
      </div>
      <span className="cbk-actions">
        {b.dealId && (
          <button type="button" className="cbk-btn" title="Открыть сделку" aria-label="Открыть сделку" onClick={() => openCrm('deal', b.dealId!)}>
            <Icon name="deal" size={15} />
          </button>
        )}
        {onOpenDay && (
          <button type="button" className="cbk-btn" title="В календаре" aria-label="Открыть в календаре" onClick={() => onOpenDay(dayKey(b.start, tz))}>
            <Icon name="calendar" size={15} />
          </button>
        )}
      </span>
      {!b.bookingId && <span className="cbk-gone">Брони уже нет в Битрикс24 — даты из полей сделки</span>}
    </article>
  );
}

/** Окно «Прошедшие брони»: те же карточки; `items === null` — список ещё загружается. */
export function PastBookingsDialog({
  items,
  total,
  error,
  tz,
  onOpenDay,
  onClose,
}: {
  items: ClientBookingDto[] | null;
  total: number;
  error: string;
  tz: string;
  onOpenDay?: (date: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);
  return createPortal(
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet cbk-sheet" role="dialog" aria-modal="true" aria-label="Прошедшие брони" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>
            Прошедшие брони <span className="pill">{items?.length ?? total}</span>
          </h2>
          <button type="button" aria-label="Закрыть" onClick={onClose}>
            ×
          </button>
        </header>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        {!items && !error && <p className="muted">Загружаем брони…</p>}
        {items && !items.length && <p className="muted">Прошедших броней нет.</p>}
        {items && items.length > 0 && (
          <div className="cbk-list">
            {items.map((b, i) => (
              <ClientBookingCard key={`${b.bookingId ?? `d${b.dealId}`}:${i}`} b={b} tz={tz} onOpenDay={onOpenDay} />
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
