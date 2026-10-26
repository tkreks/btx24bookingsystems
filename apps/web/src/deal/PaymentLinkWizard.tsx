import { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_PAYMENT_LINK_MESSAGE,
  PAYMENT_KIND_LABELS,
  PAYMENT_KINDS,
  PAYMENT_LINK_VAR,
  PAYMENT_MAX_TIMEOUT_HOURS,
  type PaymentKind,
  type PaymentPreviewDto,
  type PaymentRequestDto,
} from '@btx24/shared';
import { apiGet, apiPost } from '../api.js';
import { MinimizeButton } from '../Minimize.js';

const PURPOSES = ['Предоплата за бронирование', 'Доплата за бронирование', 'Дополнительные услуги'];

/** Часы срока из минут группы: не больше 24, без срока — пусто. */
export function defaultHours(minutes: number | null): string {
  if (!minutes || minutes <= 0) return '';
  return String(Math.min(PAYMENT_MAX_TIMEOUT_HOURS, Math.max(1, Math.round(minutes / 60))));
}

/** Срок в часах: пусто — без срока; иначе целое 1–24. */
export function parseHours(v: string): number | null | 'invalid' {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= 1 && n <= PAYMENT_MAX_TIMEOUT_HOURS ? n : 'invalid';
}

/**
 * «Отправить ссылку на оплату» во встройке сделки (решение владельца 2026-10-26): основание и сумма,
 * срок оплаты (часов, не больше 24) → текст клиенту (по умолчанию «Просим Вам произвести оплату
 * {{СсылкаНаОплату}}», можно изменить) → счёт и сообщение со ссылкой (`POST /payments`).
 */
export function PaymentLinkWizard({ dealId, onClose, onCreateBooking }: { dealId: number; onClose: () => void; onCreateBooking?: () => void }) {
  const [step, setStep] = useState<'form' | 'message' | 'done'>('form');
  const [kind, setKind] = useState<PaymentKind>('prepayment');
  const [groupId, setGroupId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PaymentPreviewDto | null>(null);
  const [purpose, setPurpose] = useState(PURPOSES[0]);
  const [amount, setAmount] = useState('');
  const [hours, setHours] = useState('');
  const [message, setMessage] = useState(DEFAULT_PAYMENT_LINK_MESSAGE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<PaymentRequestDto | null>(null);
  const [copied, setCopied] = useState(false);
  // Один ключ на окно: повторное нажатие «Отправить» не выставит второй счёт.
  const key = useRef(crypto.randomUUID());

  useEffect(() => {
    let active = true;
    apiGet<PaymentPreviewDto>(`/payments/preview?dealId=${dealId}&kind=${kind}${groupId ? `&groupId=${encodeURIComponent(groupId)}` : ''}`).then(
      (p) => {
        if (!active) return;
        setPreview(p);
        setAmount(p.amount !== null ? String(p.amount) : '');
        setHours(defaultHours(p.timeoutMinutes));
        setError('');
      },
      (e) => active && setError(e instanceof Error ? e.message : 'Не удалось рассчитать счёт'),
    );
    return () => {
      active = false;
    };
  }, [dealId, kind, groupId]);

  const sum = Number(amount.replace(',', '.'));
  const h = parseHours(hours);
  const blocking = (preview?.problems ?? []).filter((p) => !(sum > 0 && /сумм/i.test(p)));
  const formError = !purpose.trim() ? 'Укажите основание' : !(sum > 0) ? 'Укажите сумму' : h === 'invalid' ? `Срок — целое число часов от 1 до ${PAYMENT_MAX_TIMEOUT_HOURS}` : '';
  const ready = !!preview && !blocking.length && !preview.bookingMissing && !formError;

  const send = async () => {
    if (busy || !ready || h === 'invalid') return;
    setBusy(true);
    setError('');
    try {
      const r = await apiPost<PaymentRequestDto>('/payments', {
        idempotencyKey: key.current,
        dealId,
        kind,
        groupId: preview?.groupId ?? undefined,
        amount: sum,
        bookingId: preview?.bookingId ?? null,
        purpose: purpose.trim(),
        timeoutHours: h,
        message: message.trim() || DEFAULT_PAYMENT_LINK_MESSAGE,
      });
      setResult(r);
      setStep('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось отправить ссылку');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={() => !busy && onClose()}>
      <div className="sheet pay-wizard" role="dialog" aria-modal="true" aria-label="Ссылка на оплату" onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>Ссылка на оплату</h3>
          <MinimizeButton label="Ссылка на оплату" />
          <button type="button" aria-label="Закрыть" disabled={busy} onClick={onClose}>
            ×
          </button>
        </header>
        <ol className="pay-wizard-steps" aria-label="Шаги">
          <li className={step === 'form' ? 'active' : 'done'}>Основание и сумма</li>
          <li className={step === 'message' ? 'active' : step === 'done' ? 'done' : ''}>Сообщение</li>
          <li className={step === 'done' ? 'active' : ''}>Готово</li>
        </ol>

        {step === 'form' && (
          <div className="pay-wizard-body">
            <div className="pay-wizard-kinds" role="radiogroup" aria-label="Вид платежа">
              {PAYMENT_KINDS.map((k) => (
                <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>
                  {PAYMENT_KIND_LABELS[k]}
                </button>
              ))}
            </div>
            {(preview?.groupOptions.length ?? 0) > 1 && (
              <label>
                Группа
                <select value={preview?.groupId ?? ''} onChange={(e) => setGroupId(e.target.value)}>
                  {preview!.groupOptions.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Основание
              <input value={purpose} maxLength={200} onChange={(e) => setPurpose(e.target.value)} placeholder="За что платит клиент" />
            </label>
            <div className="pay-wizard-chips">
              {PURPOSES.map((p) => (
                <button key={p} type="button" className={`cb-tag${purpose === p ? ' active' : ''}`} onClick={() => setPurpose(p)}>
                  {p}
                </button>
              ))}
            </div>
            <div className="pay-wizard-row">
              <label>
                Сумма, ₽
                <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
              </label>
              <label>
                Срок оплаты, часов
                <input inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="без срока" aria-describedby="pay-hours-hint" />
              </label>
            </div>
            <p id="pay-hours-hint" className="muted pay-wizard-hint">
              Не больше {PAYMENT_MAX_TIMEOUT_HOURS} ч. Срок считается с момента отправки ссылки.
              {kind === 'prepayment' ? ' Не оплатили в срок — ссылка аннулируется, бронь снимается.' : ' Не оплатили в срок — ссылка аннулируется.'}
            </p>
            {!preview && !error && <p className="muted">Рассчитываем счёт…</p>}
            {blocking.map((p) => (
              <p key={p} className="notice error">
                {p}
              </p>
            ))}
            {preview?.bookingMissing && (
              <p className="notice error">
                Группа требует бронь перед оплатой.{' '}
                {onCreateBooking && (
                  <button type="button" className="link" onClick={onCreateBooking}>
                    Создать бронь
                  </button>
                )}
              </p>
            )}
            {error && <p className="notice error" role="alert">{error}</p>}
            <footer className="form-actions">
              <button type="button" className="primary" disabled={!ready} title={formError || undefined} onClick={() => setStep('message')}>
                Далее
              </button>
              <button type="button" onClick={onClose}>
                Отмена
              </button>
            </footer>
          </div>
        )}

        {step === 'message' && (
          <div className="pay-wizard-body">
            <p className="pay-wizard-summary">
              <b>{purpose}</b> · {new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(sum)} ₽ · {h ? `срок ${h} ч` : 'без срока'}
            </p>
            <label>
              Сообщение клиенту
              <textarea rows={5} maxLength={4000} value={message} onChange={(e) => setMessage(e.target.value)} />
            </label>
            <p className="muted pay-wizard-hint">
              <code>{PAYMENT_LINK_VAR}</code> заменится ссылкой на оплату. Уберёте — ссылка встанет отдельной строкой в конце.{' '}
              {message.trim() !== DEFAULT_PAYMENT_LINK_MESSAGE && (
                <button type="button" className="link" onClick={() => setMessage(DEFAULT_PAYMENT_LINK_MESSAGE)}>
                  Вернуть текст по умолчанию
                </button>
              )}
            </p>
            {error && <p className="notice error" role="alert">{error}</p>}
            <footer className="form-actions">
              <button type="button" className="primary" disabled={busy || !ready} onClick={() => void send()}>
                {busy ? 'Выставляем счёт…' : 'Отправить клиенту'}
              </button>
              <button type="button" disabled={busy} onClick={() => setStep('form')}>
                Назад
              </button>
            </footer>
          </div>
        )}

        {step === 'done' && result && (
          <div className="pay-wizard-body">
            {result.status === 'sent' && result.messageSent && <p className="notice success">Ссылка на оплату отправлена клиенту.{result.deadline ? ' Срок оплаты пошёл.' : ''}</p>}
            {result.status === 'sent' && !result.messageSent && <p className="notice error">Счёт выставлен, но сообщение клиенту не ушло — отправьте ссылку вручную.</p>}
            {result.status === 'link_pending' && <p className="notice">Счёт выставлен, ссылка формируется. Отправим её клиенту автоматически, как только портал её поставит.</p>}
            {result.status === 'failed' && <p className="notice error">{result.error ?? 'Не удалось выставить счёт'}</p>}
            {result.warnings.map((w) => (
              <p key={w} className="notice">
                {w}
              </p>
            ))}
            {result.link && (
              <p className="pay-wizard-link">
                <a href={result.link} target="_blank" rel="noreferrer">
                  {result.link}
                </a>
                <button
                  type="button"
                  className="link"
                  onClick={() =>
                    void navigator.clipboard.writeText(result.link ?? '').then(
                      () => setCopied(true),
                      () => setCopied(false),
                    )
                  }
                >
                  {copied ? 'Скопировано' : 'Скопировать'}
                </button>
              </p>
            )}
            <footer className="form-actions">
              <button type="button" className="primary" onClick={onClose}>
                Готово
              </button>
            </footer>
          </div>
        )}
      </div>
    </div>
  );
}
