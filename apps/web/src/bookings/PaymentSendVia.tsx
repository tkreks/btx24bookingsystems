import { useEffect, useState } from 'react';
import { messengerLabel, type CreatePaymentDto, type MessengerDealTargetsDto } from '@btx24/shared';
import { apiGet } from '../api.js';
import { MessengerKindIcon } from '../messengers/MessengerSearchButton.js';
import { fmtLinePhone } from '../openlines/ChannelFilter.js';

export type PaymentVia = NonNullable<CreatePaymentDto['via']>;

/**
 * Кнопка отправки ссылки на оплату (решение владельца 2026-10-26). Рабочий чат с клиентом есть — одна
 * кнопка, ссылка уходит в него. Нет — мессенджеры, где клиент найден: нажатие выставляет счёт и
 * открывает новый чат с клиентом сделки этой ссылкой; клиента нигде нет — «только выставить счёт».
 */
export function PaymentSendVia({
  dealId,
  noChat,
  disabled,
  busy,
  label,
  busyLabel,
  className,
  onSend,
}: {
  dealId: number;
  /** `PaymentPreviewDto.chatProblem`: рабочего чата нет. */
  noChat: boolean;
  disabled: boolean;
  busy: boolean;
  label: string;
  busyLabel: string;
  className: string;
  onSend: (via?: PaymentVia) => void;
}) {
  const [data, setData] = useState<MessengerDealTargetsDto | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!noChat) return;
    let active = true;
    setData(null);
    setFailed(false);
    void apiGet<MessengerDealTargetsDto>(`/messengers/deal-targets/${dealId}`).then(
      (d) => active && setData(d),
      () => active && setFailed(true),
    );
    return () => {
      active = false;
    };
  }, [dealId, noChat]);

  if (!noChat)
    return (
      <button type="button" className={className} disabled={disabled || busy} onClick={() => onSend()}>
        {busy ? busyLabel : label}
      </button>
    );
  const found = (data?.targets ?? []).filter((t) => t.status === 'found' && t.to);
  return (
    <div className="pay-via" aria-label="Куда отправить ссылку">
      <span className="pay-via-title">{busy ? busyLabel : 'Куда отправить ссылку'}</span>
      {!data && !failed && <p className="muted">Ищем клиента в мессенджерах…</p>}
      {data && !data.contact && <p className="muted">У сделки нет контакта — укажите клиента в сделке или отправьте ссылку сами.</p>}
      {(failed || (data?.contact && !found.length)) && <p className="muted">Клиент не найден в мессенджерах — выставьте счёт и отправьте ссылку сами.</p>}
      {!!found.length && (
        <div className="pay-via-list">
          {found.map((t) => (
            <button key={t.messenger.id} type="button" className="pay-via-btn" disabled={disabled || busy} onClick={() => onSend({ messengerId: t.messenger.id, to: t.to! })}>
              <MessengerKindIcon kind={t.messenger.kind} size={28} />
              <span>
                <b>{t.messenger.title || messengerLabel(t.messenger.kind)}</b>
                <small>{fmtLinePhone(t.messenger.phone)}</small>
              </span>
            </button>
          ))}
        </div>
      )}
      {(data || failed) && (
        <button type="button" className="link pay-via-only" disabled={disabled || busy} onClick={() => onSend()}>
          Только выставить счёт
        </button>
      )}
    </div>
  );
}
