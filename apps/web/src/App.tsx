import { useEffect, useState } from 'react';
import type { AppEnterDto, SessionInfo } from '@btx24/shared';
import { apiGet, apiPost, ApiRequestError } from './api.js';
import { initB24, placementContext, type PlacementContext } from './b24.js';
import { CalendarPage } from './calendar/CalendarPage.js';
import { SessionOverlay } from './SessionOverlay.js';
import { startSessionWatch } from './session-guard.js';

type Boot =
  | { state: 'loading' }
  | { state: 'outside' }
  | { state: 'error'; message: string }
  | { state: 'ready'; session: SessionInfo; placement: PlacementContext };

export function App() {
  const [boot, setBoot] = useState<Boot>({ state: 'loading' });

  useEffect(() => {
    void (async () => {
      if (!(await initB24())) return setBoot({ state: 'outside' });
      try {
        const session = await apiGet<SessionInfo>('/session');
        const placement = placementContext();
        setBoot({ state: 'ready', session, placement });
        // Вход — в журнал действий (откуда открыли); сбой записи не мешает работе.
        void apiPost('/activity/enter', { placement: placement.placement, dealId: placement.dealId } satisfies AppEnterDto).catch(() => undefined);
        startSessionWatch();
      } catch (e) {
        setBoot({ state: 'error', message: e instanceof ApiRequestError ? e.message : 'Не удалось подключиться к серверу приложения' });
      }
    })();
  }, []);

  if (boot.state === 'loading') return <div className="screen-center muted">Загрузка…</div>;
  if (boot.state === 'outside') return <div className="screen-center"><div className="card"><h1>Система бронирования</h1><p className="muted">Откройте приложение из Битрикс24.</p></div></div>;
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
  return (
    <>
      <CalendarPage session={boot.session} placement={boot.placement} />
      <SessionOverlay />
    </>
  );
}
