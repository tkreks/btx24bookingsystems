import { useEffect, useState } from 'react';
import type { ClientInvoiceDto, ClientInvoicesDto } from '@btx24/shared';
import { apiGet } from '../api.js';
import { openPortalPath } from '../b24.js';
import { freshPoll } from '../fresh-poll.js';
import { fmtDateTime, fmtMoney } from '../format.js';
import { LoadProgress } from '../dashboard/LoadProgress.js';

/** «ещё 1 ч 20 мин» до конца срока ссылки; срок вышел — «срок вышел»; без срока — пусто. */
export function linkTimeLeft(deadline: string | null, now: number): string {
  if (!deadline) return '';
  const min = Math.floor((Date.parse(deadline) - now) / 60_000);
  if (min < 0) return 'срок вышел';
  if (min < 1) return 'меньше минуты';
  const h = Math.floor(min / 60);
  return `ещё ${h ? `${h} ч ` : ''}${min % 60 ? `${min % 60} мин` : ''}`.trim();
}

/**
 * Счета клиента во встройке сделки (решение владельца 2026-10-26): по всем его сделкам — ждут оплаты или
 * оплачены (до конца брони). Тонкая строка: тег сделки, сумма, дата и время, основание, срок ссылки;
 * клик — счёт в Битрикс24. Счёт другой сделки — оранжевым тегом.
 */
export function ClientInvoicesBlock({ dealId, timezone, revision = 0 }: { dealId: number; timezone: string; revision?: number }) {
  const [data, setData] = useState<ClientInvoicesDto | null>(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let active = true;
    const stop = freshPoll(
      () =>
        apiGet<ClientInvoicesDto>(`/payments/client-invoices?dealId=${dealId}`).then(
          (v) => active && (setData(v), setError('')),
          (e: unknown) => active && setError(e instanceof Error ? e.message : 'Не удалось загрузить счета'),
        ),
      60_000,
    );
    return () => {
      active = false;
      stop();
    };
  }, [dealId, revision]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const items = data?.invoices ?? [];
  return (
    <section className="day-panel dash-block deal-ws-invoices">
      <p className="dash-attention-title muted">
        Счета клиента
        {data && <span className="pill">{items.length}</span>}
      </p>
      {!data && !error && <p className="muted"><LoadProgress name="deal-invoices" label="Загрузка счетов" /></p>}
      {error && <p className="notice error" role="alert">{error}</p>}
      {data && !items.length && <p className="muted">Нет счетов, ждущих оплаты, и оплаченных по действующим броням.</p>}
      {items.length > 0 && (
        <ul className="ci-rows">
          {items.map((i) => (
            <li key={i.invoiceId}>
              <InvoiceRow i={i} timezone={timezone} now={now} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function InvoiceRow({ i, timezone, now }: { i: ClientInvoiceDto; timezone: string; now: number }) {
  const left = linkTimeLeft(i.deadline, now);
  return (
    <button type="button" className={`ci-row ${i.state}`} title={`Открыть счёт #${i.invoiceId} в Битрикс24 · ${i.dealTitle}`} onClick={() => openPortalPath(`/crm/type/31/details/${i.invoiceId}/`)}>
      <span className={`ci-tag${i.thisDeal ? '' : ' other'}`}>{i.thisDeal ? 'Эта сделка' : `Другая сделка #${i.dealId}`}</span>
      <b className="ci-amount">{fmtMoney(i.amount, i.currency)}</b>
      <span className="ci-date muted">{i.createdAt ? fmtDateTime(i.createdAt, timezone) : ''}</span>
      <span className="ci-purpose">{i.purpose}</span>
      <span className={`ci-state${left === 'срок вышел' ? ' late' : ''}`}>{i.state === 'paid' ? 'Оплачен' : left ? `Ссылка: ${left}` : 'Ждёт оплату'}</span>
    </button>
  );
}
