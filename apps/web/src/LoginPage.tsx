import { useState, type FormEvent } from 'react';
import type { ExternalLoginDto } from '@btx24/shared';
import { apiPost } from './api.js';

const DOMAIN_KEY = 'btx24.loginDomain';
const TAB_KEY = 'btx24.loginTab';

function saved(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* без запоминания */
  }
}

/** Вход по логину и паролю (внешние пользователи, ADR 0021): cookie ставит сервер, затем — экран брони. */
function PasswordForm({ domain }: { domain: string }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await apiPost('/external/login', { login, password, ...(domain.trim() ? { domain: domain.trim() } : {}) } satisfies ExternalLoginDto);
      window.location.assign('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось войти');
      setBusy(false);
    }
  };
  return (
    <form className="login-password" onSubmit={(e) => void submit(e)}>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <label>
        <span className="muted">Логин</span>
        <input name="username" autoComplete="username" autoCapitalize="none" value={login} onChange={(e) => setLogin(e.target.value)} required />
      </label>
      <label>
        <span className="muted">Пароль</span>
        <input name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </label>
      <button className="primary" type="submit" disabled={busy || !login.trim() || !password}>
        {busy ? 'Входим…' : 'Войти'}
      </button>
    </form>
  );
}

/**
 * Вход вне портала: сотрудник — своим аккаунтом Битрикс24 (`/api/auth/login` → OAuth), внешний
 * пользователь — по логину и паролю. Адрес портала нужен, только если приложение стоит на нескольких.
 */
export function LoginPage({ error }: { error: string }) {
  const [domain, setDomain] = useState(() => saved(DOMAIN_KEY));
  const [tab, setTab] = useState<'bitrix' | 'password'>(() => (saved(TAB_KEY) === 'bitrix' ? 'bitrix' : 'password'));
  const choose = (t: 'bitrix' | 'password') => {
    setTab(t);
    remember(TAB_KEY, t);
  };
  const domainField = (
    <label className="login-domain">
      <span className="muted">Адрес портала — нужен, только если приложение стоит на нескольких</span>
      <input name="domain" placeholder="company.bitrix24.ru" value={domain} onChange={(e) => setDomain(e.target.value)} onBlur={() => remember(DOMAIN_KEY, domain.trim())} autoComplete="url" />
    </label>
  );
  return (
    <div className="screen-center">
      <div className="card login-card">
        <h1>Система бронирования</h1>
        <div className="segmented login-tabs" role="tablist" aria-label="Способ входа">
          <button type="button" role="tab" aria-selected={tab === 'password'} className={tab === 'password' ? 'active' : ''} onClick={() => choose('password')}>
            Логин и пароль
          </button>
          <button type="button" role="tab" aria-selected={tab === 'bitrix'} className={tab === 'bitrix' ? 'active' : ''} onClick={() => choose('bitrix')}>
            Битрикс24
          </button>
        </div>
        {tab === 'bitrix' ? (
          <form method="get" action="/api/auth/login" onSubmit={() => remember(DOMAIN_KEY, domain.trim())}>
            <p className="muted">Войдите своим аккаунтом Битрикс24 — работа идёт с теми же правами, что и в портале.</p>
            {error && (
              <p className="notice error" role="alert">
                {error}
              </p>
            )}
            {domainField}
            <button className="primary" type="submit">
              Войти через Битрикс24
            </button>
          </form>
        ) : (
          <>
            <p className="muted">Для пользователей без Битрикс24: логин и пароль выдаёт администратор приложения.</p>
            <PasswordForm domain={domain} />
            <details className="login-more">
              <summary className="muted">Адрес портала</summary>
              {domainField}
            </details>
          </>
        )}
      </div>
    </div>
  );
}
