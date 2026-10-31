import { useEffect, useState } from 'react';
import { PAYMENT_KIND_LABELS, type AwaitingInvoiceDto, type AwaitingInvoicesDto } from '@btx24/shared';
import { openCrm } from '../b24.js';
import { linkTimeLeft } from '../deal/ClientInvoicesBlock.js';
import { InvoiceViewDialog } from '../deal/InvoiceViewDialog.js';
import { fmtDateTime, fmtMoney } from '../format.js';
import { DashBadge } from '../openlines/RecentCalls.js';
import { BlockLoading } from './BlockLoading.js';
import { useDashboardQuery } from './DashboardSync.js';

/**
 * Блок «Счета, ожидающие оплату» (решение владельца 2026-10-31): только счета, по которым ждём оплату
 * (ссылка у клиента), раньше истекающие — сверху; самый срочный — крупной карточкой с отсчётом.
 * Нажатие — просмотр счёта.
 */
export function AwaitingInvoicesBlock({ timezone }: { timezone: string }) {
  const { data, error } = useDashboardQuery<AwaitingInvoicesDto>('/payments/awaiting', undefined, 60_000);
  const [open, setOpen] = useState<AwaitingInvoiceDto | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Отсчёт — с точностью до минуты.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const items = data?.invoices ?? [];
  const [first, ...rest] = items;
  const show = (i: AwaitingInvoiceDto) => (i.invoiceId ? setOpen(i) : openCrm('deal', i.dealId));
  const leftOf = (i: AwaitingInvoiceDto) => (i.deadline ? linkTimeLeft(i.deadline, now) : 'без срока');
  return (
    <section className="day-panel dash-block dash-awaiting">
      <DashBadge name="coin" />
      <p className="dash-attention-title muted">
        Счета, ожидающие оплату
        {data && <span className="pill">{items.length}</span>}
      </p>
      {error && <p className="muted">{error}</p>}
      {!data && !error && <BlockLoading rows={3} />}
      {data && !items.length && <p className="muted">Счетов в ожидании оплаты нет.</p>}
      {first && (
        <button type="button" className={`aw-first${first.deadline && Date.parse(first.deadline) - now < 30 * 60_000 ? ' soon' : ''}`} title={`${first.dealTitle} — открыть счёт`} onClick={() => show(first)}>
          <span className="aw-first-left">
            <b className="aw-amount">{fmtMoney(first.amount, 'RUB')}</b>
            <span className="aw-deal">{first.purpose || PAYMENT_KIND_LABELS[first.kind]} · {first.dealTitle}</span>
          </span>
          <span className="aw-countdown">
            <span className="aw-countdown-label">истечёт раньше всех</span>
            <b>{leftOf(first)}</b>
          </span>
        </button>
      )}
      {rest.length > 0 && (
        <ul className="aw-rows">
          {rest.map((i) => (
            <li key={i.requestId}>
              <button type="button" className="aw-row" title={`${i.dealTitle} · выставлен ${fmtDateTime(i.createdAt, timezone)} — открыть счёт`} onClick={() => show(i)}>
                <b className="aw-amount">{fmtMoney(i.amount, 'RUB')}</b>
                <span className="aw-deal">{i.purpose || PAYMENT_KIND_LABELS[i.kind]} · {i.dealTitle}</span>
                <span className={`ci-left${leftOf(i) === 'срок вышел' ? ' late' : ''}`}>{leftOf(i)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && open.invoiceId && (
        <InvoiceViewDialog dealId={open.dealId} invoiceId={open.invoiceId} timezone={timezone} onClose={() => setOpen(null)} />
      )}
    </section>
  );
}
