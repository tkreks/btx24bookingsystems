import { useState } from 'react';
import type { SessionInfo } from '@btx24/shared';
import { apiGet, apiPost } from '../api.js';

/** Ввод временного пароля к настройкам (его выдаёт администратор приложения). */
export function TempAccessDialog({ onGranted, onClose }: { onGranted: (s: SessionInfo) => void; onClose: () => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await apiPost('/settings-access', { code });
      onGranted(await apiGet<SessionInfo>('/session'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось проверить пароль');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <form
        className="sheet temp-access"
        role="dialog"
        aria-modal="true"
        aria-label="Доступ к настройкам"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim()) void submit();
        }}
      >
        <h3>Доступ к настройкам</h3>
        <p className="muted">
          Настройки доступны администраторам приложения. Если администратор выдал вам временный пароль — введите его.
        </p>
        <input
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Временный пароль"
          aria-label="Временный пароль"
          autoComplete="off"
          spellCheck={false}
          maxLength={40}
        />
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="submit" className="primary" disabled={busy || !code.trim()}>
            {busy ? 'Проверка…' : 'Открыть настройки'}
          </button>
          <button type="button" onClick={onClose}>
            Отмена
          </button>
        </div>
      </form>
    </div>
  );
}
