import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { MessengerStatusDto } from '@btx24/shared';
import { MessengerKindIcon } from '../messengers/MessengerSearchButton.js';
import { fmtLinePhone } from '../openlines/ChannelFilter.js';
import { DashBadge } from '../openlines/RecentCalls.js';
import { MessengerScreen } from '../settings/MessengerScreen.js';
import { BlockLoading } from './BlockLoading.js';
import { useDashboardQuery } from './DashboardSync.js';

/**
 * «Мессенджеры»: номера групп сотрудника, которые работают или с ошибкой (с описанием ошибки). «Экран» —
 * окно мессенджера по VNC с файлами для отправки (право писать с номера); остальные — только статус.
 */
export function MessengersBlock() {
  const { data, error } = useDashboardQuery<MessengerStatusDto[]>('/messengers/status');
  const [screen, setScreen] = useState<MessengerStatusDto | null>(null);
  const failed = data?.filter((m) => m.state !== 'ready').length ?? 0;
  return (
    <section className="day-panel dash-block dash-messengers">
      <DashBadge name="chat" />
      <p className="dash-attention-title muted">
        Мессенджеры
        {!!failed && <span className="pill waiting" title="С ошибкой">{failed}</span>}
      </p>
      {error && <p className="muted">{error}</p>}
      {!data && !error && <BlockLoading rows={2} />}
      {data && !data.length && <p className="muted">Подключённых мессенджеров ваших групп нет.</p>}
      <ul className="dash-messenger-list">
        {data?.map((m) => {
          const ok = m.state === 'ready';
          return (
            <li key={m.id} className={ok ? 'ok' : 'failed'}>
              <MessengerKindIcon kind={m.kind} size={26} />
              <span className="dash-messenger-name">
                <b>{m.title || fmtLinePhone(m.phone)}</b>
                {m.title && <span className="muted">{fmtLinePhone(m.phone)}</span>}
                {!ok && m.error && <span className="dash-messenger-error" role="alert">{m.error}</span>}
              </span>
              <span className={`pill ${ok ? 'ok' : 'danger'}`}>{ok ? 'Работает' : 'Ошибка'}</span>
              {m.canScreen && (
                <button type="button" className="dash-messenger-screen" title="Открыть окно мессенджера (VNC)" onClick={() => setScreen(m)}>
                  Экран
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {/* Окно — поверх всего дашборда, а не внутри ячейки сетки. */}
      {screen && createPortal(<MessengerScreen id={screen.id} base="/messengers" files title={`Экран: ${screen.title || fmtLinePhone(screen.phone)}`} onClose={() => setScreen(null)} />, document.body)}
    </section>
  );
}
