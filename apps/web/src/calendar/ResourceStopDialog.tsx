import { useEffect, useState } from 'react';
import { todayIn, type ResourceStopCheckDto, type ResourceStopDto } from '@btx24/shared';
import { apiDelete, apiPost } from '../api.js';
import { fmtDateTime } from '../format.js';
import { MinimizeButton } from '../Minimize.js';
import { StopSign } from './DayGrid.js';

const ru = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;

/**
 * Стоп ресурса (решение владельца 2026-10-23): с какого по какой день → проверка броней ресурса за
 * период в Битрикс24 → броней нет — причина и «Поставить стоп»; есть — список: их нужно перенести или
 * отменить. Действующие стопы ресурса — с кнопкой «Снять».
 */
export function ResourceStopDialog({
  resource,
  timezone,
  date,
  onClose,
  onChanged,
}: {
  resource: { id: number; name: string };
  timezone: string;
  /** День календаря — начало периода по умолчанию. */
  date: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const start = date < todayIn(timezone) ? todayIn(timezone) : date;
  const [from, setFrom] = useState(start);
  const [to, setTo] = useState(start);
  const [reason, setReason] = useState('');
  const [check, setCheck] = useState<ResourceStopCheckDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<ResourceStopDto | null>(null);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [busy, onClose]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось выполнить');
    } finally {
      setBusy(false);
    }
  };
  // Проверка — заново при смене дат (результат прошлого периода не подходит).
  const fresh = check && check.from === from && check.to === to ? check : null;
  const doCheck = () => run(async () => setCheck(await apiPost<ResourceStopCheckDto>('/resource-stops/check', { resourceId: resource.id, from, to })));

  return (
    <div className="sheet-backdrop" onClick={() => !busy && onClose()}>
      <form
        className="sheet stop-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={`Стоп ресурса «${resource.name}»`}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (!fresh) return void doCheck();
          if (fresh.bookings.length) return;
          void run(async () => {
            setDone(await apiPost<ResourceStopDto>('/resource-stops', { resourceId: resource.id, from, to, reason: reason.trim() }));
            onChanged();
          });
        }}
      >
        <header>
          <h2>
            <StopSign size={20} /> Стоп · {resource.name}
          </h2>
          <MinimizeButton label={`Стоп ${resource.name}`} />
          <button type="button" aria-label="Закрыть" disabled={busy} onClick={onClose}>
            ×
          </button>
        </header>
        {done ? (
          <>
            <p className="notice">
              Ресурс закрыт для бронирования с {ru(done.from)} по {ru(done.to)}: {done.reason}
            </p>
            <div className="form-actions">
              <button type="button" className="primary" onClick={onClose}>
                Готово
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="stop-period">
              <label>
                С
                <input type="date" value={from} min={todayIn(timezone)} required onChange={(e) => setFrom(e.target.value)} />
              </label>
              <label>
                по
                <input type="date" value={to} min={from} required onChange={(e) => setTo(e.target.value)} />
              </label>
              <span className="muted">включительно</span>
            </div>
            {fresh && fresh.bookings.length > 0 && (
              <div className="notice error" role="alert">
                <b>В этот период есть брони ({fresh.bookings.length}) — их нужно перенести или отменить, потом ставить стоп.</b>
                <ul className="stop-bookings">
                  {fresh.bookings.map((b) => (
                    <li key={b.id}>
                      {fmtDateTime(b.start, timezone)} — {fmtDateTime(b.end, timezone)} · {b.name || `Бронь #${b.id}`}
                      {b.dealId ? ` · сделка #${b.dealId}` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {fresh && !fresh.bookings.length && (
              <label className="stop-reason">
                Броней нет. Причина стопа <i className="df-req">*</i>
                <textarea rows={2} maxLength={500} autoFocus required minLength={3} value={reason} placeholder="Ремонт, санобработка, закрыто на сезон…" onChange={(e) => setReason(e.target.value)} />
              </label>
            )}
            {(fresh?.stops ?? []).length > 0 && (
              <div className="stop-existing">
                <b>Уже действует:</b>
                {fresh!.stops.map((s) => (
                  <div key={s.id} className="stop-existing-row">
                    <span>
                      {ru(s.from)} — {ru(s.to)}: {s.reason} <span className="muted">· {s.createdBy}</span>
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await apiDelete(`/resource-stops/${s.id}`);
                          onChanged();
                          setCheck(await apiPost<ResourceStopCheckDto>('/resource-stops/check', { resourceId: resource.id, from, to }));
                        })
                      }
                    >
                      Снять
                    </button>
                  </div>
                ))}
              </div>
            )}
            {error && (
              <p className="notice error" role="alert">
                {error}
              </p>
            )}
            <div className="form-actions">
              {!fresh ? (
                <button type="submit" className="primary" disabled={busy || !from || !to || to < from}>
                  {busy ? 'Проверяю брони…' : 'Проверить брони'}
                </button>
              ) : (
                !fresh.bookings.length && (
                  <button type="submit" className="danger" disabled={busy || reason.trim().length < 3}>
                    Поставить стоп
                  </button>
                )
              )}
              <button type="button" disabled={busy} onClick={onClose}>
                Отмена
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
