import { useEffect, useState, type FormEvent } from 'react';
import type { ChangeExternalPasswordDto, ExternalUserSummaryDto } from '@btx24/shared';
import { apiGet, apiPut } from '../api.js';

function PasswordForm({
  user,
  onDirty,
  onBusy,
}: {
  user: ExternalUserSummaryDto;
  onDirty: (dirty: boolean) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    onBusy(true);
    setError('');
    setMessage('');
    try {
      await apiPut<void>(`/admin/external-users/${encodeURIComponent(user.id)}/password`, {
        password,
      } satisfies ChangeExternalPasswordDto);
      setPassword('');
      onDirty(false);
      setMessage('Пароль изменён.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось сменить пароль');
    } finally {
      setBusy(false);
      onBusy(false);
    }
  };
  return (
    <form className="settings-form" onSubmit={save}>
      <h4>
        {user.login} · {user.role === 'VIEWER' ? 'Просмотр' : 'Технолог'}
        {user.disabled ? ' · отключён' : ''}
      </h4>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      <fieldset disabled={busy}>
        <label>
          Новый пароль
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={128}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              onDirty(!!e.target.value);
              setMessage('');
            }}
          />
        </label>
        <button type="submit">{busy ? 'Сохранение…' : 'Сменить пароль'}</button>
      </fieldset>
    </form>
  );
}
export function ExternalPasswords({
  onDirty,
  onBusy,
}: {
  onDirty: (dirty: boolean) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [users, setUsers] = useState<ExternalUserSummaryDto[] | null>(null);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let active = true;
    void apiGet<ExternalUserSummaryDto[]>('/admin/external-users').then(
      (u) => {
        if (active) setUsers(u);
      },
      (e) => {
        if (active) setError(e instanceof Error ? e.message : 'Не удалось загрузить пользователей');
      },
    );
    return () => {
      active = false;
    };
  }, []);
  return (
    <section>
      <h3>Пользователи прямой ссылки</h3>
      <p className="muted">Новый пароль — от 12 до 128 символов. Существующие пароли не отображаются.</p>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {users === null && !error && <p>Загрузка…</p>}
      {users?.length === 0 && <p className="muted">Пользователей пока нет.</p>}
      {users?.map((u) => (
        <PasswordForm
          key={u.id}
          user={u}
          onBusy={onBusy}
          onDirty={(value) => {
            const next = { ...dirty, [u.id]: value };
            setDirty(next);
            onDirty(Object.values(next).some(Boolean));
          }}
        />
      ))}
    </section>
  );
}
