import { useEffect, useState } from 'react';
import { todayIn, type CallCardDto, type MyGroupDto } from '@btx24/shared';
import { apiGet } from '../api.js';
import { BookingForm, type BookingFormContext } from '../bookings/BookingForm.js';
import { PaymentDialog } from '../bookings/PaymentDialog.js';
import { ErrorBoundary } from '../ErrorBoundary.js';
import { bookingContextFromCard, CallCard, type CallRef } from './CallCard.js';
import { CallWatcher } from './CallWatcher.js';

/**
 * Звонки клиентов поверх приложения: `watch` — всплывающая карточка, когда сотрудник ответил на
 * звонок; `page` — встройка в окно звонка Битрикс24 (`CALL_CARD`). Из карточки — мастер брони с
 * выбранным клиентом и предложенной сделкой, затем (предоплата) — окно оплаты.
 */
export function CallLayer({ timezone, mode, call }: { timezone: string; mode: 'watch' | 'page'; call?: CallRef }) {
  const [groups, setGroups] = useState<MyGroupDto[] | null>(null);
  const [form, setForm] = useState<BookingFormContext | null>(null);
  const [payment, setPayment] = useState<{ dealId: number; bookingId: number | null; amount?: number | null; fixedDeal?: boolean } | null>(null);
  const [note, setNote] = useState('');
  useEffect(() => {
    apiGet<MyGroupDto[]>('/groups').then(setGroups, () => setGroups([]));
  }, []);
  const canCreate = !!groups?.some((g) => g.permissions.includes('booking.create'));
  const canPay = !!groups?.some((g) => g.permissions.includes('payment.send'));
  const create = (card: CallCardDto) => setForm(bookingContextFromCard(card, todayIn(timezone)));

  return (
    <>
      {mode === 'watch' && <CallWatcher timezone={timezone} canCreate={canCreate} onCreate={create} />}
      {mode === 'page' && call && (
        <div className="page call-page">
          {note && <p className="notice">{note}</p>}
          <CallCard call={call} timezone={timezone} canCreate={canCreate} onCreate={create} />
        </div>
      )}
      {form && groups && (
        <ErrorBoundary where="booking-form" onClose={() => setForm(null)}>
          <BookingForm
            groups={groups}
            timezone={timezone}
            context={form}
            onClose={() => setForm(null)}
            onDone={(r) => {
              setForm(null);
              setNote(r.note);
              if (r.payment && r.dealId && canPay)
                setPayment({ dealId: r.dealId, bookingId: r.booking?.bookingId ?? null, amount: r.payment.amount, fixedDeal: r.payment.fixedDeal });
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
    </>
  );
}
