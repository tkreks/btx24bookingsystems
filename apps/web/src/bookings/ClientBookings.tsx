import { freshPoll } from '../fresh-poll.js';
import { useCallback, useEffect, useState } from 'react';
import type { ClientBookingDto, ClientBookingsDto } from '@btx24/shared';
import { apiGet } from '../api.js';
import { fmtDateTime, fmtTime } from '../format.js';
import { Icon } from '../openlines/icons.js';
import { ClientBookingCard, PastBookingsDialog } from './ClientBookingCard.js';

/**
 * Клиент в шапке чата — тегами: сделки (успешные) · средний чек · брони (по клику — список) ·
 * ближайшая бронь; зелёный «+» — новая бронь (шаг выбора сделки). Имя клиента — в шапке, здесь не повторяем.
 * Раскрытый список — только текущие/будущие карточками; прошедшие — ссылкой «Прошедшие брони (N)» в окне.
 */
export function ClientBookings({
  chatId,
  timezone,
  canCreate,
  revision,
  onOpenDay,
  onCreate,
}: {
  chatId: number;
  timezone: string;
  canCreate: boolean;
  /** Сменился — перечитать (после создания брони). */
  revision: number;
  onOpenDay?: (date: string) => void;
  onCreate: (data: ClientBookingsDto | null) => void;
}) {
  const [data, setData] = useState<ClientBookingsDto | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  // Окно открыто для этого чата (сменили чат — закрыто само).
  const [pastFor, setPastFor] = useState<number | null>(null);
  const pastOpen = pastFor === chatId;
  // Полный список прошедших — лениво, при открытии окна (`?history=1`); `recent` — пока он грузится.
  const [past, setPast] = useState<{ chatId: number; items: ClientBookingDto[] | null; error: string } | null>(null);
  const closePast = useCallback(() => setPastFor(null), []);

  const load = useCallback(
    () =>
      apiGet<ClientBookingsDto>(`/openlines/chats/${chatId}/bookings`).then(
        (d) => {
          setData(d);
          setError('');
        },
        (e) => setError(e instanceof Error ? e.message : 'Брони клиента недоступны'),
      ),
    [chatId],
  );
  useEffect(() => {
    let active = true;
    setData(null);
    const stop = freshPoll(() => apiGet<ClientBookingsDto>(`/openlines/chats/${chatId}/bookings`).then(
      (d) => {
        if (!active) return;
        setData(d);
        setError('');
      },
      (e) => active && setError(e instanceof Error ? e.message : 'Брони клиента недоступны'),
    ));
    return () => { active = false; stop(); };
  }, [chatId, revision]);

  useEffect(() => {
    if (!pastOpen) return;
    let active = true;
    apiGet<ClientBookingsDto>(`/openlines/chats/${chatId}/bookings?history=1`).then(
      (d) => active && setPast({ chatId, items: d.history ?? d.recent, error: '' }),
      (e) => active && setPast((p) => ({ chatId, items: p?.chatId === chatId ? p.items : null, error: e instanceof Error ? e.message : 'Прошедшие брони недоступны' })),
    );
    return () => {
      active = false;
    };
  }, [pastOpen, chatId, revision]);

  const next = data?.upcoming[0];
  const money = (v: number, cur: string | null) =>
    `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(v)} ${!cur || cur === 'RUB' ? '₽' : cur}`;
  return (
    <div className="client-bookings">
      <div className="cb-stats" role="group" aria-label="Клиент: сделки и брони">
        {!data && <span className="muted">{error || 'Загрузка данных клиента…'}</span>}
        {data && (
          <>
            <span
              className="cb-tag"
              title="Успешные сделки клиента: не проиграны и бронь уже прошла (без брони — выигранные; оплаченные сертификаты)"
              aria-label={`Сделок: ${data.won.count}`}
            >
              <Icon name="handshake" size={14} />
              Сделок <b>{data.won.count}</b>
            </span>
            {data.won.avgCheck !== null && (
              <span className="cb-tag" title="Средний чек успешных сделок" aria-label={`Средний чек: ${money(data.won.avgCheck, data.won.currency)}`}>
                Ср. чек <b>{money(data.won.avgCheck, data.won.currency)}</b>
              </span>
            )}
            <button
              className="cb-tag"
              aria-expanded={open}
              title="Брони клиента: текущие и будущие — списком, прошедшие — в отдельном окне"
              aria-label={`Броней: ${data.past + data.upcoming.length}`}
              onClick={() => setOpen(!open)}
            >
              <Icon name="calendar" size={14} />
              Броней <b>{data.past + data.upcoming.length}</b>
            </button>
            {next && (
              <button
                className={`cb-tag cb-next${next.when === 'now' ? ' now' : ''}`}
                onClick={() => setOpen(true)}
                title={next.when === 'now' ? 'Бронь идёт сейчас' : 'Ближайшая бронь'}
                aria-label={`${next.when === 'now' ? 'Идёт сейчас' : 'Ближайшая бронь'}: ${fmtDateTime(next.start, timezone)}`}
              >
                <Icon name="hourglass" size={14} />
                {next.when === 'now' ? 'Идёт сейчас' : 'Ближайшая'} <b>{next.when === 'now' ? fmtTime(next.end, timezone) : fmtDateTime(next.start, timezone)}</b>
                {data.upcoming.length > 1 && <span className="muted">+{data.upcoming.length - 1}</span>}
              </button>
            )}
          </>
        )}
        {canCreate && (
          <button className="cb-add" onClick={() => onCreate(data)} aria-label="Новая бронь" title="Новая бронь: выбрать сделку клиента">
            <span aria-hidden="true">+</span>
          </button>
        )}
      </div>
      {open && data && (
        <div className="cb-list">
          {!data.contactId && <p className="muted">К чату не привязан контакт CRM — брони ищутся только по сделке чата.</p>}
          {data.upcoming.map((b, i) => (
            <ClientBookingCard key={`${b.bookingId ?? `d${b.dealId}`}:${i}`} b={b} tz={timezone} onOpenDay={onOpenDay} />
          ))}
          {!data.upcoming.length && <p className="muted cb-empty">Текущих и будущих броней нет.</p>}
          <div className="cb-list-foot">
            {data.past > 0 && (
              <button type="button" className="link cb-past-link" onClick={() => setPastFor(chatId)}>
                Прошедшие брони ({data.past})
              </button>
            )}
            <button type="button" className="link" onClick={() => void load()}>
              Обновить
            </button>
          </div>
        </div>
      )}
      {pastOpen && data && (
        <PastBookingsDialog
          // Все прошедшие уже в `recent` (до 5) — показываем сразу, иначе ждём полный список.
          items={past?.chatId === chatId && past.items ? past.items : data.recent.length >= data.past ? data.recent : null}
          total={data.past}
          error={past?.chatId === chatId ? past.error : ''}
          tz={timezone}
          onOpenDay={
            onOpenDay &&
            ((d) => {
              setPastFor(null);
              onOpenDay(d);
            })
          }
          onClose={closePast}
        />
      )}
    </div>
  );
}
