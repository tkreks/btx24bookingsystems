import { useCallback, useEffect, useState } from 'react';
import type { ClientBookingDto, ClientBookingsDto } from '@btx24/shared';
import { apiGet } from '../api.js';
import { openCrm } from '../b24.js';
import { fmtDateTime, fmtTime } from '../format.js';
import { dayKey } from '../openlines/chat-list.js';
import { Icon } from '../openlines/icons.js';

/**
 * Клиент в шапке чата одной строкой: имя · 🤝 повторные сделки · ~ средний чек · 📅 прошедшие брони ·
 * ⏳ ближайшая бронь (подписи — в подсказках); по клику — список броней; «+ Бронь».
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
    apiGet<ClientBookingsDto>(`/openlines/chats/${chatId}/bookings`).then(
      (d) => {
        if (!active) return;
        setData(d);
        setError('');
      },
      (e) => active && setError(e instanceof Error ? e.message : 'Брони клиента недоступны'),
    );
    return () => {
      active = false;
    };
  }, [chatId, revision]);

  const next = data?.upcoming[0];
  const money = (v: number, cur: string | null) =>
    `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(v)} ${!cur || cur === 'RUB' ? '₽' : cur}`;
  return (
    <div className="client-bookings">
      <div className="cb-stats">
        {data?.contact?.name && (
          <button className="link cb-client" onClick={() => openCrm('contact', data.contact!.id)} title="Открыть контакт в CRM">
            {data.contact.name}
          </button>
        )}
        {!data && <span className="muted">{error || 'Загрузка данных клиента…'}</span>}
        {data && (
          <>
            <span
              className="cb-stat"
              title="Повторные сделки: состоявшиеся сделки клиента — не проиграны и бронь уже прошла (без брони — выигранные)"
              aria-label={`Повторных сделок: ${data.won.count}`}
            >
              <Icon name="handshake" size={15} />
              <b>{data.won.count}</b>
            </span>
            {data.won.avgCheck !== null && (
              <span className="cb-stat" title="Средний чек повторных сделок" aria-label={`Средний чек: ${money(data.won.avgCheck, data.won.currency)}`}>
                <span className="cb-approx" aria-hidden="true">
                  ~
                </span>
                <b>{money(data.won.avgCheck, data.won.currency)}</b>
              </span>
            )}
            <button
              className="cb-stat link"
              aria-expanded={open}
              title="Прошедшие брони — показать список"
              aria-label={`Прошедших броней: ${data.past}`}
              onClick={() => setOpen(!open)}
            >
              <Icon name="calendar" size={15} />
              <b>{data.past}</b>
            </button>
            {next && (
              <button
                className={`cb-stat link cb-next${next.when === 'now' ? ' now' : ''}`}
                onClick={() => setOpen(true)}
                title={next.when === 'now' ? 'Бронь идёт сейчас' : 'Ближайшая бронь'}
                aria-label={`${next.when === 'now' ? 'Идёт сейчас' : 'Ближайшая бронь'}: ${fmtDateTime(next.start, timezone)}`}
              >
                <Icon name="hourglass" size={15} />
                <b>{next.when === 'now' ? 'сейчас' : fmtDateTime(next.start, timezone)}</b>
                {data.upcoming.length > 1 && <span className="muted">+{data.upcoming.length - 1}</span>}
              </button>
            )}
          </>
        )}
        {canCreate && (
          <button className="cb-create" onClick={() => onCreate(data)}>
            + Бронь
          </button>
        )}
      </div>
      {open && data && (
        <div className="cb-list">
          {!data.contactId && <p className="muted">К чату не привязан контакт CRM — брони ищутся только по сделке чата.</p>}
          {data.upcoming.length > 0 && <h4>Текущие и будущие</h4>}
          {data.upcoming.map((b, i) => (
            <Row key={`u${i}`} b={b} tz={timezone} onOpenDay={onOpenDay} />
          ))}
          {data.recent.length > 0 && <h4>Прошедшие (последние {data.recent.length} из {data.past})</h4>}
          {data.recent.map((b, i) => (
            <Row key={`p${i}`} b={b} tz={timezone} onOpenDay={onOpenDay} />
          ))}
          {!data.upcoming.length && !data.recent.length && <p className="muted">Броней не найдено.</p>}
          <button className="link" onClick={() => void load()}>
            Обновить
          </button>
        </div>
      )}
    </div>
  );
}

function Row({ b, tz, onOpenDay }: { b: ClientBookingDto; tz: string; onOpenDay?: (date: string) => void }) {
  const range =
    dayKey(b.start, tz) === dayKey(b.end, tz) ? `${fmtDateTime(b.start, tz)}–${fmtTime(b.end, tz)}` : `${fmtDateTime(b.start, tz)} – ${fmtDateTime(b.end, tz)}`;
  return (
    <div className={`cb-row ${b.when}`}>
      <div>
        <b>{range}</b> {b.when === 'now' && <span className="pill waiting">идёт сейчас</span>}
        <div className="muted">
          {b.resources.join(', ') || (b.bookingId ? '' : 'бронь удалена, даты из сделки')}
          {b.deal && ` · ${b.deal.title}${b.deal.stageSemantic === 'S' ? ' (выиграна)' : b.deal.stageSemantic === 'F' ? ' (проиграна)' : ''}`}
        </div>
      </div>
      <span className="row-actions">
        {b.dealId && (
          <button className="link" onClick={() => openCrm('deal', b.dealId!)}>
            Сделка
          </button>
        )}
        {onOpenDay && (
          <button className="link" onClick={() => onOpenDay(dayKey(b.start, tz))}>
            В календарь
          </button>
        )}
      </span>
    </div>
  );
}
