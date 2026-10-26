import { useRef, useState } from 'react';
import {
  DEFAULT_PAYMENT_LINK_MESSAGE,
  PAYMENT_LINK_VAR,
  PAYMENT_MAX_TIMEOUT_HOURS,
  PAYMENT_PURPOSES,
  type PaymentPreviewDto,
  type PaymentRequestDto,
} from '@btx24/shared';
import { apiPost } from '../api.js';

/** Срок в часах: пусто — без срока; иначе целое 1–24. */
export function parseHours(v: string): number | null | 'invalid' {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= 1 && n <= PAYMENT_MAX_TIMEOUT_HOURS ? n : 'invalid';
}

const HOURS = [1, 3, 12, 24];

/**
 * Вкладка «Произвольная» окна оплаты (решение владельца 2026-10-26): основание (быстрый выбор или своё),
 * сумма, срок действия ссылки (часов, не больше 24) и текст клиенту — по умолчанию «Просим Вам произвести
 * оплату {{СсылкаНаОплату}}». Стадию и поля оплаты сделки не трогает, бронь по сроку не снимает.
 */
export function CustomPaymentForm({ dealId, preview, onSent }: { dealId: number; preview: PaymentPreviewDto | null; onSent: (r: PaymentRequestDto) => void }) {
  const [purpose, setPurpose] = useState(PAYMENT_PURPOSES[0]);
  const [amount, setAmount] = useState('');
  const [hours, setHours] = useState('1');
  const [message, setMessage] = useState(DEFAULT_PAYMENT_LINK_MESSAGE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Свой ключ на окно: повторное нажатие не выставит второй счёт; после успеха — новый.
  const key = useRef(crypto.randomUUID());
  const sum = Number(amount.replace(',', '.'));
  const h = parseHours(hours);
  const formError = !purpose.trim() ? 'Укажите основание' : !(sum > 0) ? 'Укажите сумму' : h === 'invalid' ? `Срок — целое число часов от 1 до ${PAYMENT_MAX_TIMEOUT_HOURS}` : '';
  const problems = preview?.problems ?? [];

  const send = async () => {
    if (busy || formError || problems.length || !preview || h === 'invalid') return;
    setBusy(true);
    setError('');
    try {
      const r = await apiPost<PaymentRequestDto>('/payments', {
        idempotencyKey: key.current,
        dealId,
        kind: 'custom',
        groupId: preview.groupId ?? undefined,
        amount: sum,
        purpose: purpose.trim(),
        timeoutHours: h,
        message: message.trim() || DEFAULT_PAYMENT_LINK_MESSAGE,
      });
      key.current = crypto.randomUUID();
      setAmount('');
      onSent(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось отправить ссылку');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="pay-custom" aria-label="Произвольная оплата">
      <div className="pay-custom-field">
        <span className="pay-custom-label">Основание</span>
        <div className="pay-custom-chips" role="group" aria-label="Быстрый выбор основания">
          {PAYMENT_PURPOSES.map((p) => (
            <button key={p} type="button" className={purpose === p ? 'active' : ''} aria-pressed={purpose === p} onClick={() => setPurpose(p)}>
              {p}
            </button>
          ))}
        </div>
        <input value={purpose} maxLength={200} aria-label="Основание" placeholder="За что платит клиент" onChange={(e) => setPurpose(e.target.value)} />
      </div>
      <div className="pay-custom-row">
        <label className="pay-custom-field">
          <span className="pay-custom-label">Сумма</span>
          <span className="pay-custom-money">
            <input inputMode="decimal" value={amount} placeholder="0" aria-label="Сумма, ₽" onChange={(e) => setAmount(e.target.value)} />
            <b>₽</b>
          </span>
        </label>
        <div className="pay-custom-field">
          <span className="pay-custom-label">Срок действия ссылки</span>
          <div className="pay-custom-hours" role="group" aria-label="Срок действия ссылки, часов">
            {HOURS.map((x) => (
              <button key={x} type="button" className={hours === String(x) ? 'active' : ''} aria-pressed={hours === String(x)} onClick={() => setHours(String(x))}>
                {x} ч
              </button>
            ))}
            <input inputMode="numeric" value={hours} aria-label="Часов (1–24, пусто — без срока)" placeholder="—" onChange={(e) => setHours(e.target.value)} />
          </div>
        </div>
      </div>
      <p className="muted pay-custom-hint">До {PAYMENT_MAX_TIMEOUT_HOURS} ч с момента отправки; пусто — без срока. Не оплатили в срок — ссылка аннулируется, бронь остаётся.</p>
      <label className="pay-custom-field">
        <span className="pay-custom-label">Сообщение клиенту</span>
        <textarea rows={3} maxLength={4000} value={message} onChange={(e) => setMessage(e.target.value)} />
      </label>
      <p className="muted pay-custom-hint">
        <code>{PAYMENT_LINK_VAR}</code> заменится ссылкой; уберёте — ссылка встанет последней строкой.{' '}
        {message.trim() !== DEFAULT_PAYMENT_LINK_MESSAGE && (
          <button type="button" className="link" onClick={() => setMessage(DEFAULT_PAYMENT_LINK_MESSAGE)}>
            Текст по умолчанию
          </button>
        )}
      </p>
      {preview?.groupName && <p className="muted pay-custom-hint">Счёт — по настройкам группы «{preview.groupName}».</p>}
      {problems.map((p) => (
        <p key={p} className="notice error">
          {p}
        </p>
      ))}
      {error && <p className="notice error" role="alert">{error}</p>}
      <button type="button" className="pay-custom-send" disabled={busy || !!formError || !preview || problems.length > 0} title={formError || undefined} onClick={() => void send()}>
        {busy ? 'Выставляем счёт…' : 'Получить оплату'}
      </button>
    </section>
  );
}
