import { useEffect, useState } from 'react';
import { INVOICE_DISPLAY_LABELS, type ClientInvoiceDto, type ClientInvoicesDto } from '@btx24/shared';
import { apiGet } from '../api.js';
import { freshPoll } from '../fresh-poll.js';
import { fmtDateTime, fmtMoney } from '../format.js';
import { LoadProgress } from '../dashboard/LoadProgress.js';
import { InvoiceViewDialog } from './InvoiceViewDialog.js';

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
 * Счета клиента во встройке сделки (решения владельца 2026-10-26 и 2026-10-31): по всем его сделкам.
 * Активные — с действующей бронью (любой статус, кроме «Проиграна») и открытые, ждущие оплаты; статус —
 * цветным тегом, рядом у открытых — отсчёт до просрочки (точность — минута). Архивные — кнопкой
 * «Архив (N)» внизу, в модальном окне. Нажатие на счёт — окно просмотра как в шаге выставления.
 */
export function ClientInvoicesBlock({ dealId, timezone, revision = 0 }: { dealId: number; timezone: string; revision?: number }) {
  const [data, setData] = useState<ClientInvoicesDto | null>(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [viewing, setViewing] = useState<ClientInvoiceDto | null>(null);
  const [rev, setRev] = useState(0);

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
  }, [dealId, revision, rev]);

  // Отсчёт до просрочки — с точностью до минуты.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const items = data?.invoices ?? [];
  const active = items.filter((i) => !i.archived);
  const archived = items.filter((i) => i.archived);
  return (
    <section className="day-panel dash-block deal-ws-invoices">
      <p className="dash-attention-title muted">
        Счета клиента
        {data && <span className="pill">{active.length}</span>}
      </p>
      {!data && !error && <p className="muted"><LoadProgress name="deal-invoices" label="Загрузка счетов" /></p>}
      {error && <p className="notice error" role="alert">{error}</p>}
      {data && !active.length && <p className="muted">Активных счетов нет{archived.length ? ' — старые в архиве.' : '.'}</p>}
      {active.length > 0 && (
        <ul className="ci-rows">
          {active.map((i) => (
            <li key={i.invoiceId}>
              <InvoiceRow i={i} timezone={timezone} now={now} onOpen={() => setViewing(i)} />
            </li>
          ))}
        </ul>
      )}
      {archived.length > 0 && (
        <button type="button" className="link ci-archive-btn" onClick={() => setArchiveOpen(true)}>
          Архив ({archived.length})
        </button>
      )}
      {archiveOpen && (
        <div className="sheet-backdrop" onClick={() => setArchiveOpen(false)}>
          <div className="sheet bk ci-archive" role="dialog" aria-modal="true" aria-label="Архив счетов" onClick={(e) => e.stopPropagation()}>
            <header className="bk-head">
              <div>
                <h3>Архив счетов</h3>
                <div className="bk-sub">Проигранные и прошедшие счета клиента</div>
              </div>
              <button type="button" className="bk-close" aria-label="Закрыть" onClick={() => setArchiveOpen(false)}>
                ×
              </button>
            </header>
            <div className="ci-archive-body">
              <ul className="ci-rows ci-archive-rows">
                {archived.map((i) => (
                  <li key={i.invoiceId}>
                    <InvoiceRow i={i} timezone={timezone} now={now} onOpen={() => setViewing(i)} />
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
      {viewing && (
        <InvoiceViewDialog
          dealId={viewing.dealId}
          invoiceId={viewing.invoiceId}
          timezone={timezone}
          onClose={() => setViewing(null)}
          onChanged={() => setRev((n) => n + 1)}
        />
      )}
    </section>
  );
}

function InvoiceRow({ i, timezone, now, onOpen }: { i: ClientInvoiceDto; timezone: string; now: number; onOpen: () => void }) {
  const left = i.state === 'open' ? linkTimeLeft(i.deadline, now) : '';
  return (
    <button type="button" className={`ci-row st-${i.status}`} title={`Счёт #${i.invoiceId} · ${i.dealTitle} — открыть`} onClick={onOpen}>
      <span className={`ci-tag${i.thisDeal ? '' : ' other'}`}>{i.thisDeal ? 'Эта сделка' : `Сделка #${i.dealId}`}</span>
      <b className="ci-amount">{fmtMoney(i.amount, i.currency)}</b>
      <span className="ci-date muted">{i.createdAt ? fmtDateTime(i.createdAt, timezone) : ''}</span>
      <span className="ci-purpose">{i.purpose}</span>
      <span className={`ci-status ${i.status}`}>{INVOICE_DISPLAY_LABELS[i.status]}</span>
      {left && <span className={`ci-left${left === 'срок вышел' ? ' late' : ''}`}>{left}</span>}
    </button>
  );
}
