import { useState } from 'react';

const DOMAIN_KEY = 'btx24.loginDomain';

function savedDomain(): string {
  try {
    return localStorage.getItem(DOMAIN_KEY) ?? '';
  } catch {
    return '';
  }
}

/**
 * Вход вне портала: сотрудник подтверждает вход своим аккаунтом Битрикс24 на странице портала
 * (`/api/auth/login` → OAuth). Адрес портала нужен, только если приложение стоит на нескольких.
 */
export function LoginPage({ error }: { error: string }) {
  const [domain, setDomain] = useState(savedDomain);
  return (
    <div className="screen-center">
      <form
        className="card login-card"
        method="get"
        action="/api/auth/login"
        onSubmit={() => {
          try {
            localStorage.setItem(DOMAIN_KEY, domain.trim());
          } catch {
            /* без запоминания */
          }
        }}
      >
        <h1>Система бронирования</h1>
        <p className="muted">Войдите своим аккаунтом Битрикс24 — работа идёт с теми же правами, что и в портале.</p>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <label className="login-domain">
          <span className="muted">Адрес портала — нужен, только если приложение стоит на нескольких</span>
          <input name="domain" placeholder="company.bitrix24.ru" value={domain} onChange={(e) => setDomain(e.target.value)} autoComplete="url" />
        </label>
        <button className="primary" type="submit">
          Войти через Битрикс24
        </button>
      </form>
    </div>
  );
}
