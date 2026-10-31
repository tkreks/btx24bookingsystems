import { useState } from 'react';
import { invoiceInWork, type DealInvoicesDto, type PaymentRequestKind } from '@btx24/shared';
import { apiGet } from '../api.js';
import { InvoiceViewDialog } from '../deal/InvoiceViewDialog.js';

/**
 * Кнопка рядом с ошибкой «По этой сделке уже выставлен такой счёт»: открывает этот счёт — с текстом,
 * который ушёл клиенту, и кнопкой «Отправить повторно».
 */
export function ActiveInvoiceLink({ dealId, kind, timezone }: { dealId: number; kind: PaymentRequestKind; timezone: string }) {
  const [invoiceId, setInvoiceId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);

  const open = async () => {
    if (busy) return;
    setBusy(true);
    setMissing(false);
    try {
      const d = await apiGet<DealInvoicesDto>(`/payments/invoices?dealId=${dealId}`);
      const found = d.invoices.find((i) => invoiceInWork(i) && i.request?.kind === kind);
      if (found) setInvoiceId(found.invoiceId);
      else setMissing(true);
    } catch {
      setMissing(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className="link" disabled={busy} onClick={() => void open()}>
        {busy ? 'Открываем…' : 'Перейти к счёту'}
      </button>
      {missing && <span className="muted"> Счёт не найден — откройте «Счета» сделки.</span>}
      {invoiceId !== null && <InvoiceViewDialog dealId={dealId} invoiceId={invoiceId} timezone={timezone} onClose={() => setInvoiceId(null)} />}
    </>
  );
}
