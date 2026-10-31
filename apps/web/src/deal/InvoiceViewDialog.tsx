import { useEffect, useState } from 'react';
import {
  INVOICE_DISPLAY_LABELS,
  invoiceDisplayStatus,
  PAYMENT_KIND_LABELS,
  type InvoiceViewDto,
  type PaymentRequestDto,
} from '@btx24/shared';
import { apiGet, apiPost } from '../api.js';
import { openCrm, openPortalPath } from '../b24.js';
import { MessagePreviewText } from '../bookings/MessagePreview.js';
import { paymentFeedback } from '../bookings/payment-feedback.js';
import { fmtDateTime, fmtMoney } from '../format.js';
import { MinimizeButton } from '../Minimize.js';
import { BlockLoading } from '../dashboard/BlockLoading.js';
import { initials } from '../openlines/chat-list.js';
import { Icon } from '../openlines/icons.js';
import { linkTimeLeft } from './ClientInvoicesBlock.js';

/** Тег статуса счёта: зелёный — оплачен, синий — выставлен, оранжевый — ждёт оплату, красный — проигран. */
export function InvoiceStatusTag({ status }: { status: InvoiceViewDto['status'] }) {
  return <span className={`ci-status ${status}`}>{INVOICE_DISPLAY_LABELS[status]}</span>;
}

/**
 * Просмотр счёта (решение владельца 2026-10-31): окно как в шаге выставления, но только чтение.
 * Счёт не приложения (данных о выставлении нет) — оверлей «счёт старый, данные могут быть неточными»
 * с кнопкой «Показать собранные данные». У счёта в статусе «Выставлен» — кнопка «Отправить счёт»:
 * сообщение уходит клиенту, срок идёт с этого момента, статус меняется на «Ждёт оплату» сам.
 */
export function InvoiceViewDialog({
  dealId,
  invoiceId,
  timezone,
  onClose,
  onChanged,
}: {
  dealId: number;
  invoiceId: number;
  timezone: string;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [data, setData] = useState<InvoiceViewDto | null>(null);
  const [error, setError] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<PaymentRequestDto | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let active = true;
    apiGet<InvoiceViewDto>(`/payments/invoice-view?dealId=${dealId}&invoiceId=${invoiceId}`).then(
      (v) => active && setData(v),
      (e: unknown) => active && setError(e instanceof Error ? e.message : 'Не удалось загрузить счёт'),
    );
    return () => {
      active = false;
    };
  }, [dealId, invoiceId]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [busy, onClose]);

  const req = data?.request ?? null;
  const status = data ? (req ? invoiceDisplayStatus(data.state, { status: req.status, messageSent: req.messageSent }) : data.status) : null;
  const canSend = !!data && !!req && status === 'issued' && (req.status === 'link_pending' || req.status === 'sent');
  const left = data && status === 'waiting' ? linkTimeLeft(req?.deadline ?? null, now) : '';
  const fmt = (iso: string) =>
    new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

  const send = async () => {
    if (!req || busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await apiPost<PaymentRequestDto>(`/payments/requests/${req.id}/send`, {});
      setSent(r);
      setData((d) => (d ? { ...d, request: r } : d));
      if (r.messageSent) onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось отправить счёт');
    } finally {
      setBusy(false);
    }
  };
  const copy = async (link: string) => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const covered = !!data && !data.complete && !revealed;
  return (
    <div className="sheet-backdrop" onClick={() => !busy && onClose()}>
      <div className="sheet bk pw iv" role="dialog" aria-modal="true" aria-label={`Счёт #${invoiceId}`} onClick={(e) => e.stopPropagation()}>
        <header className="bk-head">
          <div>
            <h3>
              Счёт #{invoiceId}
              {status && <InvoiceStatusTag status={status} />}
              {left && <span className={`ci-left${left === 'срок вышел' ? ' late' : ''}`}>{left}</span>}
            </h3>
            <div className="bk-sub">
              Режим просмотра{data?.stageName ? ` · стадия «${data.stageName}»` : ''}
              {data?.createdAt ? ` · от ${fmtDateTime(data.createdAt, timezone)}` : ''}
            </div>
          </div>
          <div className="pw-head-actions">
            <MinimizeButton label={`Счёт #${invoiceId}`} />
            <button type="button" className="bk-close" aria-label="Закрыть" disabled={busy} onClick={onClose}>
              ×
            </button>
          </div>
        </header>

        <div className="pw-body iv-body">
          {!data && !error && <BlockLoading rows={4} />}
          {error && (
            <p className="notice error pw-notice" role="alert">
              {error}
            </p>
          )}
          {covered && (
            <div className="iv-cover" role="note">
              <Icon name="alert" size={26} />
              <b>Счёт старый или выставлен не из приложения</b>
              <p className="muted">Полных данных о выставлении нет — не вся информация может быть точной.</p>
              <button type="button" onClick={() => setRevealed(true)}>
                Показать собранные данные
              </button>
            </div>
          )}
          {data && !covered && (
            <>
              <section className="pw-card pw-details" aria-label="Данные счёта">
                <div className="pw-detail">
                  <span className="pw-avatar" aria-hidden="true">
                    {data.contact ? initials(data.contact.name) : <Icon name="person" size={22} />}
                  </span>
                  <div className="pw-detail-body">
                    {data.contact ? (
                      <button type="button" className="pw-link pw-primary" onClick={() => openCrm('contact', data.contact!.id)}>
                        {data.contact.name} <Icon name="external" size={13} />
                      </button>
                    ) : (
                      <div className="pw-primary muted">Клиент не указан</div>
                    )}
                    <button type="button" className="pw-link pw-secondary" onClick={() => openCrm('deal', data.dealId)}>
                      {data.dealTitle} <Icon name="external" size={12} />
                    </button>
                    <div className="pw-label">Сумма сделки: {data.dealAmount !== null ? fmtMoney(data.dealAmount, data.currency) : '—'}</div>
                  </div>
                </div>

                <div className="pw-detail">
                  <span className="pw-icon green" aria-hidden="true">
                    <Icon name="calendar" size={24} />
                  </span>
                  <div className="pw-detail-body">
                    {data.booking ? (
                      <>
                        <div className="pw-primary">
                          {data.booking.resources.length ? data.booking.resources.join(', ') : 'Бронь'} · #{data.booking.bookingId}
                        </div>
                        <div className="pw-secondary">
                          {fmt(data.booking.start)} — {fmt(data.booking.end)}
                        </div>
                      </>
                    ) : (
                      <div className="pw-primary muted">Без привязки к брони</div>
                    )}
                  </div>
                </div>

                <div className="pw-detail">
                  <span className="pw-icon" aria-hidden="true">
                    <Icon name="deal" size={24} />
                  </span>
                  <div className="pw-detail-body">
                    <div className="pw-label">Основание</div>
                    <div className="pw-primary">{data.purpose}</div>
                    <div className="pw-secondary">
                      {req ? `${PAYMENT_KIND_LABELS[req.kind]}${req.createdBy ? ` · выставил(а) ${req.createdBy}` : ''}` : 'Выставлен не из приложения'}
                    </div>
                    {req?.deadline && <div className="pw-label">Оплатить до {fmtDateTime(req.deadline, timezone)}</div>}
                  </div>
                </div>

                <div className="pw-detail pw-detail-amount">
                  <span className="pw-icon violet" aria-hidden="true">
                    <Icon name="coin" size={24} />
                  </span>
                  <div className="pw-detail-body">
                    <div className="pw-label">Сумма счёта</div>
                    <div className="pw-total">{fmtMoney(data.amount, data.currency)}</div>
                    {status && (
                      <div className="pw-secondary">
                        <InvoiceStatusTag status={status} />
                        {status === 'issued' && !req?.messageSent && <span className="muted"> срок не идёт: клиенту не отправлено</span>}
                      </div>
                    )}
                  </div>
                </div>
              </section>

              <section className="pw-card pw-message" aria-label="Сообщение клиенту">
                <div className="pw-section-head">
                  <div className="pw-section-title">
                    <span className="pw-bubble" aria-hidden="true">
                      <Icon name="chat" size={20} />
                    </span>
                    <span>Сообщение клиенту</span>
                  </div>
                </div>
                {data.messageText ? (
                  <div className="pw-preview iv-readonly">
                    <MessagePreviewText text={data.messageText} link={req?.link} deadlineText={req?.deadline ? fmtDateTime(req.deadline, timezone) : undefined} />
                  </div>
                ) : (
                  <p className="pw-hint">
                    {req ? 'Отправлялся шаблон сообщений группы — текст этой отправки не сохранён.' : 'Счёт выставлен не из приложения — сообщение клиенту неизвестно.'}
                  </p>
                )}
                {data.messageFiles.length > 0 && (
                  <div className="pw-files">
                    {data.messageFiles.map((f) => (
                      <div key={f.id} className="pw-file">
                        <span className="pw-file-preview" aria-hidden="true">
                          <Icon name={f.mime.startsWith('image/') ? 'camera' : 'clip'} size={18} />
                        </span>
                        <span className="pw-file-meta">
                          <span className="pw-file-name" title={f.name}>
                            {f.name}
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {req?.error && <p className="notice error pw-notice">{req.error}</p>}
              {sent && !error && (
                <div className={`notice pw-notice ${sent.error || !sent.messageSent ? 'error' : 'success'}`} role="status">
                  <b>{sent.messageSent ? paymentFeedback(sent) : sent.status === 'link_pending' ? 'Ссылка на оплату ещё формируется — попробуйте через минуту.' : paymentFeedback(sent)}</b>
                  {sent.warnings.map((w) => (
                    <span key={w} className="muted">
                      {' '}
                      {w}
                    </span>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <footer className="pw-footer">
          <span className="muted">
            {data && !data.complete && revealed ? 'Данные собраны из Битрикс24 — могут быть неполными.' : ''}
          </span>
          <div className="pw-send-controls">
            {req?.link && data?.state === 'open' && !covered && (
              <button type="button" onClick={() => void copy(req.link!)}>
                {copied ? 'Ссылка скопирована' : 'Скопировать ссылку'}
              </button>
            )}
            {!covered && (
              <button type="button" onClick={() => openPortalPath(`/crm/type/31/details/${invoiceId}/`)}>
                Открыть в Битрикс24
              </button>
            )}
            {canSend && !covered && (
              <button type="button" className="primary pw-send" disabled={busy} onClick={() => void send()}>
                <Icon name="send" size={16} /> {busy ? 'Отправляем…' : 'Отправить счёт'}
              </button>
            )}
            <button type="button" disabled={busy} onClick={onClose}>
              Закрыть
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
