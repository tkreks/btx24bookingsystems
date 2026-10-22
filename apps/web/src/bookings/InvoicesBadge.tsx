import { useCallback, useEffect, useState } from 'react';
import { invoiceInWork, type DealInvoicesDto } from '@btx24/shared';
import { apiGet } from '../api.js';
import { Countdown } from './Countdown.js';

/**
 * В шапке чата: сколько счетов сделки ждут оплаты и таймер ближайшего срока; по клику — окно
 * счетов. Обновляется раз в 30 секунд и после закрытия окна (`revision`).
 */
export function InvoicesBadge({ dealId, revision, onOpen }: { dealId: number; revision: number; onOpen: () => void }) {
  const [data, setData] = useState<DealInvoicesDto | null>(null);
  const load = useCallback(() => apiGet<DealInvoicesDto>(`/payments/invoices?dealId=${dealId}`).then(setData, () => undefined), [dealId]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load, revision]);
  const work = (data?.dealId === dealId ? data.invoices : []).filter(invoiceInWork);
  const nearest = work
    .map((i) => (i.request?.status === 'sent' ? i.request.deadline : null))
    .filter((d): d is string => !!d)
    .sort()[0];
  return (
    <button className={`link cv-pay${work.length ? ' has-work' : ''}`} onClick={onOpen} title="Счета сделки: в работе и все">
      Счета{work.length > 0 && <> · в работе {work.length}</>}
      {nearest && (
        <>
          {' '}
          <Countdown deadline={nearest} compact />
        </>
      )}
    </button>
  );
}
