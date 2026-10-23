import { useEffect, useState } from 'react';
import type { AppEnterDto, SessionInfo } from '@btx24/shared';
import { apiGet, apiPost, ApiRequestError } from './api.js';
import { initB24, placementContext, setStandalone, type PlacementContext } from './b24.js';
import { LoginPage } from './LoginPage.js';
import { CalendarPage } from './calendar/CalendarPage.js';
import { CallLayer } from './calls/CallLayer.js';
import { SessionOverlay } from './SessionOverlay.js';
import { startSessionWatch } from './session-guard.js';

type Boot =
  | { state: 'loading' }
  | { state: 'login'; error: string }
  | { state: 'error'; message: string }
  | { state: 'ready'; session: SessionInfo; placement: PlacementContext };

export function App() {
  const [boot, setBoot] = useState<Boot>({ state: 'loading' });

  useEffect(() => {
    void (async () => {
      const inFrame = await initB24();
      // Вне портала — вход через аккаунт Битрикс24 и cookie-сессия (WebLoginController).
      if (!inFrame) setStandalone();
      try {
        const session = await apiGet<SessionInfo>('/session');
        if (!inFrame) setStandalone(session.portal.domain);
        const placement: PlacementContext = inFrame ? placementContext() : { placement: 'STANDALONE', dealId: null };
        setBoot({ state: 'ready', session, placement });
        // Вход — в журнал действий (откуда открыли); сбой записи не мешает работе.
        void apiPost('/activity/enter', { placement: placement.placement, dealId: placement.dealId } satisfies AppEnterDto).catch(() => undefined);
        startSessionWatch();
      } catch (e) {
        if (!inFrame && e instanceof ApiRequestError && e.status === 401) return setBoot({ state: 'login', error: loginError() });
        setBoot({ state: 'error', message: e instanceof ApiRequestError ? e.message : 'Не удалось подключиться к серверу приложения' });
      }
    })();
  }, []);

  if (boot.state === 'loading') return <div className="screen-center muted">Загрузка…</div>;
  if (boot.state === 'login') return <LoginPage error={boot.error} />;
  if (boot.state === 'error') return <div className="screen-center"><div className="card error">{boot.message}</div></div>;
  if (!boot.session.appAccess)
    return (
      <div className="screen-center">
        <div className="card">
          <h1>Доступ к приложению ограничен</h1>
          <p className="muted">Приложение бронирования доступно администраторам и сотрудникам из списка доступа. Обратитесь к администратору портала.</p>
        </div>
      </div>
    );
  // Окно звонка Битрикс24: только карточка клиента (и мастер брони из неё).
  if (boot.placement.placement === 'CALL_CARD')
    return (
      <>
        <CallLayer timezone={boot.session.portal.timezone} mode="page" call={boot.placement.call} />
        <SessionOverlay />
      </>
    );
  return (
    <>
      <CalendarPage session={boot.session} placement={boot.placement} />
      <CallLayer timezone={boot.session.portal.timezone} mode="watch" />
      <SessionOverlay />
    </>
  );
}

/** Ошибка возврата с портала (`/?login_error=…`) — показать один раз и убрать из адреса. */
function loginError(): string {
  const url = new URL(window.location.href);
  const error = url.searchParams.get('login_error') ?? '';
  if (error) {
    url.searchParams.delete('login_error');
    window.history.replaceState(null, '', url);
  }
  return error;
}
