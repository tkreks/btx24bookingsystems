import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  invoiceInWork,
  PAYMENT_KIND_LABELS,
  PAYMENT_KINDS,
  PAYMENT_STATUS_LABELS,
  type DealInvoiceDto,
  type DealInvoicesDto,
  type PaymentKind,
  type PaymentPreviewDto,
  type PaymentRequestDto,
} from '@btx24/shared';
import { apiGet, apiPost } from '../api.js';
import { Countdown } from './Countdown.js';

const SOURCE: Record<PaymentPreviewDto['source'], string> = {
  fixed: 'фиксированная сумма группы',
  manual: 'ручная сумма из сделки',
  percent: 'процент от суммы сделки',
  none: '',
};
const rub = (v: number) => `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(v)} ₽`;
const STATE_LABELS: Record<DealInvoiceDto['state'], string> = { open: 'ждёт оплаты', paid: 'оплачен', failed: 'не оплачен' };

/**
 * Счёт и ссылка на оплату по сделке (ADR 0009): сумма и текст клиенту — до отправки; после —
 * статус (ссылка формируется → ждём оплату → оплачено / не оплачено в срок) и сама ссылка.
 */
export function PaymentDialog({
  dealId,
  bookingId,
  timezone,
  onClose,
}: {
  dealId: number;
  bookingId?: number | null;
  timezone: string;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<PaymentKind>('prepayment');
  const [preview, setPreview] = useState<PaymentPreviewDto | null>(null);
  const [amount, setAmount] = useState('');
  const [invoices, setInvoices] = useState<DealInvoiceDto[] | null>(null);
  const [tab, setTab] = useState<'work' | 'all'>('work');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  // Новый ключ на каждый вид платежа: повторное нажатие не выставит второй счёт.
  const keys = useMemo(() => ({ prepayment: crypto.randomUUID(), surcharge: crypto.randomUUID() }), []);

  const loadHistory = useCallback(
    () => apiGet<DealInvoicesDto>(`/payments/invoices?dealId=${dealId}`).then((d) => setInvoices(d.invoices), () => undefined),
    [dealId],
  );
  const chooseKind = (k: PaymentKind) => {
    setKind(k);
    setPreview(null);
    setError('');
  };
  useEffect(() => {
    apiGet<PaymentPreviewDto>(`/payments/preview?dealId=${dealId}&kind=${kind}${bookingId ? `&bookingId=${bookingId}` : ''}`).then(
      (p) => {
        setPreview(p);
        setAmount(p.amount !== null ? String(p.amount) : '');
      },
      (e) => setError(e instanceof Error ? e.message : 'Не удалось рассчитать счёт'),
    );
  }, [dealId, kind, bookingId]);
  useEffect(() => void loadHistory(), [loadHistory]);
  const inWork = (invoices ?? []).filter(invoiceInWork);
  // Пока ссылка формируется или ждём оплату — обновляем статус.
  const waiting = inWork.some((i) => i.request);
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => void loadHistory(), 5000);
    return () => clearInterval(t);
  }, [waiting, loadHistory]);

  const blocking = (preview?.problems ?? []).filter((p) => !(Number(amount) > 0 && /сумм/i.test(p)));
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await apiPost<PaymentRequestDto>('/payments', {
        idempotencyKey: keys[kind],
        dealId,
        kind,
        groupId: preview?.groupId ?? undefined,
        amount: Number(amount) > 0 && Number(amount) !== preview?.amount ? Number(amount) : null,
        bookingId: bookingId ?? null,
      });
      await loadHistory();
      setTab('work');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось выставить счёт');
    } finally {
      setBusy(false);
    }
  };
  const copy = async (h: PaymentRequestDto) => {
    try {
      await navigator.clipboard.writeText(h.link ?? '');
      setCopied(h.id);
    } catch {
      setCopied('');
    }
  };
  const fmt = (iso: string) => new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

  return (
    <div className="sheet-backdrop" onClick={() => !busy && onClose()}>
      <div className="sheet payment-dialog" role="dialog" aria-modal="true" aria-label="Счета сделки" onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>Счета сделки #{dealId}</h3>
          <button type="button" aria-label="Закрыть" disabled={busy} onClick={onClose}>
            ×
          </button>
        </header>
        <section className="payment-history">
          <div className="segmented" role="group" aria-label="Счета">
            <button type="button" aria-pressed={tab === 'work'} className={tab === 'work' ? 'active' : ''} onClick={() => setTab('work')}>
              В работе {inWork.length}
            </button>
            <button type="button" aria-pressed={tab === 'all'} className={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')}>
              Все счета {invoices?.length ?? ''}
            </button>
          </div>
          {!invoices && <p className="muted">Загрузка счетов…</p>}
          {invoices && tab === 'work' && !inWork.length && <p className="muted">Счетов, ожидающих оплаты, нет.</p>}
          {invoices && tab === 'all' && !invoices.length && <p className="muted">У сделки нет счетов.</p>}
          {(tab === 'work' ? inWork : (invoices ?? [])).map((i) => (
            <InvoiceRow key={`${i.invoiceId}:${i.request?.id ?? ''}`} i={i} work={tab === 'work'} fmt={fmt} copied={copied} onCopy={copy} />
          ))}
        </section>
        <h4 className="payment-new">Выставить счёт</h4>
        <div className="segmented" role="group" aria-label="Что выставить">
          {PAYMENT_KINDS.map((k) => (
            <button key={k} type="button" aria-pressed={kind === k} className={kind === k ? 'active' : ''} onClick={() => chooseKind(k)}>
              {PAYMENT_KIND_LABELS[k]}
            </button>
          ))}
        </div>
        {!preview && !error && <p className="muted">Расчёт…</p>}
        {preview && (
          <>
            {preview.groupName && <p className="muted">Группа «{preview.groupName}»{preview.timeoutMinutes ? ` · на оплату ${preview.timeoutMinutes} мин` : ''}</p>}
            <label>
              Сумма, ₽
              <input type="number" min={1} step={100} value={amount} onChange={(e) => setAmount(e.target.value)} />
              {preview.amount !== null && <span className="muted">Рассчитано: {rub(preview.amount)} — {SOURCE[preview.source]}</span>}
            </label>
            <label className="settings-block">
              Сообщение клиенту
              <textarea rows={4} readOnly value={preview.message} />
              <span className="muted">{'{link}'} заменится ссылкой, когда портал её выдаст; срок оплаты считается с момента отправки.</span>
            </label>
            {blocking.map((p) => (
              <p key={p} className="notice error">
                {p}
              </p>
            ))}
          </>
        )}
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <div className="sheet-actions">
          <button type="button" className="primary" disabled={busy || !preview || blocking.length > 0 || !(Number(amount) > 0)} onClick={() => void submit()}>
            {busy ? 'Выставляем счёт…' : 'Выставить счёт и отправить ссылку'}
          </button>
        </div>
      </div>
    </div>
  );
}

function InvoiceRow({
  i,
  work,
  fmt,
  copied,
  onCopy,
}: {
  i: DealInvoiceDto;
  work: boolean;
  fmt: (iso: string) => string;
  copied: string;
  onCopy: (h: PaymentRequestDto) => void;
}) {
  const h = i.request;
  return (
    <div className={`payment-row ${h?.status ?? i.state}`}>
      <div>
        <b>
          {h ? `${PAYMENT_KIND_LABELS[h.kind]} ` : ''}
          {rub(i.amount)}
        </b>
        {i.invoiceId > 0 && <span className="muted"> · счёт #{i.invoiceId}</span>} ·{' '}
        {h && (work || h.status !== 'sent') ? (
          <span className={`pill ${h.status}`}>{PAYMENT_STATUS_LABELS[h.status]}</span>
        ) : (
          <span className={`pill inv-${i.state}`}>{i.stageName || STATE_LABELS[i.state]}</span>
        )}
        {work && h?.deadline && h.status === 'sent' && (
          <>
            {' '}
            <Countdown deadline={h.deadline} />
          </>
        )}
      </div>
      <div className="muted">
        {i.createdAt && fmt(i.createdAt)}
        {h?.createdBy ? ` · ${h.createdBy}` : ''}
        {!h && ` · ${i.title}`}
        {h?.deadline && h.status === 'sent' ? ` · оплатить до ${fmt(h.deadline)}` : ''}
        {work && h?.status === 'sent' && !h.deadline ? ' · срок не идёт: клиенту не отправлено' : ''}
        {work && !h ? ' · выставлен не приложением — срок не отслеживается' : ''}
      </div>
      {h?.link && (h.status === 'sent' || h.status === 'link_pending') && (
        <button type="button" className="link" onClick={() => onCopy(h)}>
          {copied === h.id ? 'Ссылка скопирована' : 'Скопировать ссылку'}
        </button>
      )}
      {h?.error && <p className="notice error">{h.error}</p>}
      {work && h?.warnings.map((w) => (
        <p key={w} className="notice">
          {w}
        </p>
      ))}
    </div>
  );
}

