import { useEffect, useState } from 'react';
import { formatDuration, paymentState, type ViewerBookingDto, type ViewerDayDto, type ViewerProductsDto } from '@btx24/shared';
import { apiGet } from '../api.js';
import { fmtDate, fmtDateTime, fmtMoney, fmtTime } from '../format.js';
import { AlertIcon, BoxIcon, ClockIcon, CommentIcon, HashIcon, HouseIcon, InfoIcon, WalletIcon } from './icons.js';
import { minutesOf, resourceName, TIME_STATUS_LABELS, timeStatus } from './viewer-model.js';

const longDate = (iso: string, tz: string) => new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
const sameDay = (b: ViewerBookingDto, tz: string) => fmtDate(b.startsAt, tz) === fmtDate(new Date(Date.parse(b.endsAt) - 1).toISOString(), tz);

/** «13:00–16:00», а если бронь на несколько дней — с датами. */
export function timeRange(b: ViewerBookingDto, tz: string): string {
  return sameDay(b, tz) ? `${fmtTime(b.startsAt, tz)}–${fmtTime(b.endsAt, tz)}` : `${fmtDateTime(b.startsAt, tz)} – ${fmtDateTime(b.endsAt, tz)}`;
}

const money = (v: number | null, currency: string, empty = 'Не указана') => (v === null ? empty : fmtMoney(v, currency));

/** «3 000 ₽ · 28.10.2026 17:45» — сумма и время последней оплаты; нет данных — null. */
export function lastPaymentText(b: ViewerBookingDto, tz: string): string | null {
  if (!b.lastPaymentAt) return null;
  const when = fmtDateTime(b.lastPaymentAt, tz).replace(',', '');
  return b.lastPaymentAmount !== null ? `${fmtMoney(b.lastPaymentAmount, b.currency)} · ${when}` : when;
}

/** Тег статуса брони по времени: ожидает / идёт / завершена. */
export function StatusTag({ b }: { b: ViewerBookingDto }) {
  const st = timeStatus(b);
  return <span className={`vw-status st-${st}`}>{TIME_STATUS_LABELS[st]}</span>;
}

/** Оплаты таблицей: «26.10.2026 | + | 25 000 ₽ | Поступление»; несколько — с итогом. */
export function PaymentsTable({ b, tz }: { b: ViewerBookingDto; tz: string }) {
  if (!b.payments.length) return null;
  const total = b.payments.reduce((n, p) => n + p.amount, 0);
  return (
    <table className="vw-pays">
      <tbody>
        {b.payments.map((p) => (
          <tr key={p.at}>
            <td>{fmtDate(p.at, tz)}</td>
            <td className="vw-plus">+</td>
            <td className="vw-plus vw-num">{fmtMoney(p.amount, b.currency)}</td>
            <td className="muted">Поступление</td>
          </tr>
        ))}
        {b.payments.length > 1 && (
          <tr className="vw-pays-total">
            <td>Итого</td>
            <td className="vw-plus">+</td>
            <td className="vw-plus vw-num">{fmtMoney(total, b.currency)}</td>
            <td />
          </tr>
        )}
      </tbody>
    </table>
  );
}

/** Краткие финансы карточки: стоимость и оплачено (остаток — в полном просмотре), без неизвестных нулей. */
export function MoneyRows({ b }: { b: ViewerBookingDto }) {
  const p = paymentState(b.amount, b.paid);
  if (b.amount === null && b.paid === null) return null;
  return (
    <div className="vw-money">
      <span>
        Стоимость: <b>{money(b.amount, b.currency)}</b>
      </span>
      {b.paid !== null && <span className="vw-paid">Оплачено: {fmtMoney(b.paid, b.currency)}</span>}
      {p.overpay !== null && <span className="vw-over">Переплата: {fmtMoney(p.overpay, b.currency)}</span>}
    </div>
  );
}

export function Products({ b }: { b: ViewerBookingDto }) {
  const [data, setData] = useState<ViewerProductsDto | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!b.products) return;
    let active = true;
    apiGet<ViewerProductsDto>(`/external/bookings/${b.bookingId}/products`).then(
      (d) => active && setData(d),
      (e) => active && setError(e instanceof Error ? e.message : 'Не удалось загрузить товары'),
    );
    return () => {
      active = false;
    };
  }, [b.bookingId, b.products]);
  if (!b.products) return null;
  const total = data?.items.reduce((n, i) => n + i.sum, 0) ?? 0;
  const units = data?.items.reduce((n, i) => n + i.quantity, 0) ?? 0;
  return (
    <section className="vw-sec">
      <h3>
        <BoxIcon /> Товары и услуги
      </h3>
      {error && <p className="muted">{error}</p>}
      {!data && !error && <p className="muted">Загрузка…</p>}
      {data && !data.items.length && <p className="muted">Нет товарных позиций</p>}
      {data && !!data.items.length && (
        <>
          <ul className="vw-products">
            {data.items.map((p, i) => (
              <li key={i}>
                <span className="vw-p-name">{p.name}</span>
                <span className="vw-p-calc">
                  {p.quantity} × {fmtMoney(p.price, b.currency)}
                </span>
                <b className="vw-p-sum">{fmtMoney(p.sum, b.currency)}</b>
              </li>
            ))}
          </ul>
          <p className="vw-p-total">
            Позиций: {data.items.length} · единиц: {units} · <b>Итого {fmtMoney(total, b.currency)}</b>
          </p>
        </>
      )}
    </section>
  );
}

function Row({ k, v, cls }: { k: string; v: string | number | null | undefined; cls?: string }) {
  if (v === null || v === undefined || v === '') return null;
  return (
    <div className={`vw-row${cls ? ` ${cls}` : ''}`}>
      <span>{k}</span>
      <b>{v}</b>
    </div>
  );
}

/**
 * Полный просмотр брони — одна структура для списка (раскрытая карточка), календаря и доступности.
 * Пустые разделы не показываются; неизвестные суммы — «Не указана», а не ноль.
 */
export function BookingDetails({ b, day, header = true, products = true }: { b: ViewerBookingDto; day: ViewerDayDto; header?: boolean; products?: boolean }) {
  const tz = day.timezone;
  const p = paymentState(b.amount, b.paid);
  const hasMoney = b.amount !== null || b.paid !== null;
  return (
    <div className="vw-details">
      {header && (
        <header className="vw-d-head">
          <span className="vw-house">
            <HouseIcon />
          </span>
          <div>
            <h2>{b.title}</h2>
            <p>
              {longDate(b.startsAt, tz)} <StatusTag b={b} />
            </p>
            <p>
              <span className="vw-time-tag">
                <ClockIcon /> {timeRange(b, tz)}
              </span> · {formatDuration(minutesOf(b))}
            </p>
          </div>
        </header>
      )}
      <section className="vw-sec">
        <h3>
          <InfoIcon /> Основная информация
        </h3>
        <Row k="Ресурс" v={resourceName(day, b.resourceIds)} />
        <Row k="Клиент" v={b.clientName ?? 'Не указан'} />
        <Row k="Количество гостей" v={b.guests} />
        <Row k="Гостей программы" v={b.programGuests} cls="vw-program" />
      </section>
      {b.important && (
        <section className="vw-sec vw-important">
          <h3>
            <AlertIcon /> Важное
          </h3>
          <p className="vw-text">{b.important}</p>
        </section>
      )}
      {b.comment && (
        <section className="vw-sec">
          <h3>
            <CommentIcon /> Комментарий
          </h3>
          <p className="vw-text">{b.comment}</p>
        </section>
      )}
      {hasMoney && (
        <section className="vw-sec">
          <h3>
            <WalletIcon /> Финансы
          </h3>
          <Row k="Сумма сделки" v={money(b.amount, b.currency)} />
          <Row k="Оплачено" v={b.paid === null ? null : fmtMoney(b.paid, b.currency)} cls="vw-paid" />
          <Row k="Осталось оплатить" v={p.debt === null ? null : fmtMoney(p.debt, b.currency)} cls={p.debt ? 'vw-debt' : undefined} />
          <Row k="Процент оплаты" v={p.percent === null ? null : `${p.percent}%`} />
          <Row k="Переплата" v={p.overpay === null ? null : fmtMoney(p.overpay, b.currency)} />
          {b.payments.length > 0 && (
            <div className="vw-pays-wrap">
              <span className="muted">Оплаты</span>
              <PaymentsTable b={b} tz={tz} />
            </div>
          )}
        </section>
      )}
      {products && <Products b={b} />}
      <section className="vw-sec vw-extra">
        <h3>
          <HashIcon /> Дополнительные сведения
        </h3>
        <Row k="ID бронирования" v={b.bookingId} />
        <Row k="ID ресурса" v={b.resourceIds.join(', ')} />
        <Row k="Начало" v={fmtDateTime(b.startsAt, tz).replace(',', '')} />
        <Row k="Окончание" v={fmtDateTime(b.endsAt, tz).replace(',', '')} />
        <Row k="Статус брони" v={TIME_STATUS_LABELS[timeStatus(b)]} />
      </section>
    </div>
  );
}

/** Полный просмотр поверх экрана: на телефоне — панель снизу, на компьютере — окно по центру. */
export function BookingSheet({ b, day, onClose }: { b: ViewerBookingDto; day: ViewerDayDto; onClose: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', key);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);
  return (
    <div className="vw-sheet-back" onClick={onClose}>
      <div className="vw-sheet" role="dialog" aria-modal="true" aria-label={b.title} onClick={(e) => e.stopPropagation()}>
        <div className="vw-sheet-grip" aria-hidden="true" />
        <button type="button" className="vw-sheet-close" aria-label="Закрыть" onClick={onClose}>
          ×
        </button>
        <BookingDetails b={b} day={day} />
      </div>
    </div>
  );
}
