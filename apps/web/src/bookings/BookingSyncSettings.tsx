import { useEffect, useState } from 'react';
import type { BookingSyncSettingsDto } from '@btx24/shared';
import { apiGet, apiPost, apiPut } from '../api.js';
import { fmtDateTime } from '../format.js';

/** ⚙ → «Приложение»: сверка броней с Битрикс24 и чат уведомлений. */
export function BookingSyncSettings({ timezone }: { timezone: string }) {
  const [s, setS] = useState<BookingSyncSettingsDto | null>(null);
  const [horizon, setHorizon] = useState(180);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    apiGet<BookingSyncSettingsDto>('/admin/booking-sync').then(
      (v) => {
        if (!active) return;
        setS(v);
        setHorizon(v.syncHorizonDays);
      },
      (e) => active && setError(e instanceof Error ? e.message : 'Не удалось загрузить настройки сверки'),
    );
    return () => {
      active = false;
    };
  }, []);

  const run = async (f: () => Promise<BookingSyncSettingsDto>) => {
    setBusy(true);
    setError('');
    try {
      const v = await f();
      setS(v);
      setHorizon(v.syncHorizonDays);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-card">
      <h3>Сверка с Битрикс24 и уведомления о бронях</h3>
      <p className="muted">
        Раз в 10 минут приложение сверяет ресурсы и брони с Битрикс24. Новая бронь, созданная не через приложение, и
        расхождение по брони приложения попадают в «Уведомления» и в чат уведомлений — со статусом и кнопками.
      </p>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {!s && !error && <p className="muted">Загрузка…</p>}
      {s && (
        <>
          <p>
            Чат уведомлений:{' '}
            {s.alertChatId ? (
              <b>создан (#{s.alertChatId})</b>
            ) : (
              <button className="primary" disabled={busy} onClick={() => void run(() => apiPost('/admin/booking-sync/chat'))}>
                Создать чат уведомлений
              </button>
            )}
          </p>
          <form
            className="settings-grid"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => apiPut('/admin/booking-sync', { syncHorizonDays: horizon }));
            }}
          >
            <label>
              Сверять брони вперёд, дней
              <input type="number" min={7} max={730} value={horizon} onChange={(e) => setHorizon(Number(e.target.value))} />
            </label>
            <div className="form-actions">
              <button type="submit" disabled={busy || horizon === s.syncHorizonDays}>
                Сохранить
              </button>
            </div>
          </form>
          <p className="muted">
            {s.lastSyncAt ? `Последняя сверка: ${fmtDateTime(s.lastSyncAt, timezone)}.` : 'Сверка ещё не запускалась.'}{' '}
            {s.baselineAt
              ? `Существующие брони приняты ${fmtDateTime(s.baselineAt, timezone)} — уведомления только о новых.`
              : 'Первая сверка примет существующие брони без уведомлений.'}
          </p>
          {s.lastSyncError && (
            <div className="notice error" role="alert">
              Ошибка последней сверки: {s.lastSyncError}
            </div>
          )}
        </>
      )}
    </section>
  );
}
