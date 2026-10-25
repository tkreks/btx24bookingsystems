import { useEffect, useState } from 'react';
import type { ChatChannelDto, ChatSummary, DealChatsDto } from '@btx24/shared';
import { apiGet } from '../api.js';
import { ChannelRecovery } from '../openlines/ChannelRecovery.js';
import { hasDisabledWazzupChannel } from '../openlines/channel-error.js';
import { Icon, type IconName } from '../openlines/icons.js';
import { MinimizeButton } from '../Minimize.js';

export type DealHomeTarget = 'chat' | 'deal' | 'calendar';

const TILES: { key: DealHomeTarget; icon: IconName; title: string; hint: string }[] = [
  { key: 'chat', icon: 'chats', title: 'Чат', hint: 'Переписка с клиентом сделки' },
  { key: 'deal', icon: 'history', title: 'Сделка', hint: 'Карточка и действия сотрудников' },
  { key: 'calendar', icon: 'calendar', title: 'Календарь', hint: 'Бронирование ресурсов' },
];

/** Чат клиента сделки, где Wazzup сообщил «канал выключен» (по последнему сообщению). */
export function brokenChat(items: ChatSummary[]): ChatSummary | null {
  return items.find((c) => hasDisabledWazzupChannel(c.connector, c.lastMessage?.preview)) ?? null;
}

/**
 * Встройка сделки: стартовый экран — три большие кнопки (решение владельца 2026-10-25). Если в чате
 * клиента ошибка канала Wazzup — четвёртый шаг красным «Отправить клиенту сообщение» (2026-10-26):
 * окно восстановления канала (перейти в чат приложения, начать новый, найти клиента).
 */
export function DealHome({ dealId, timezone, onOpen, onOpenChat }: { dealId: number; timezone: string; onOpen: (target: DealHomeTarget) => void; onOpenChat: (chatId: number) => void }) {
  const [broken, setBroken] = useState<{ chat: ChatSummary; channels: ChatChannelDto[] } | null>(null);
  const [recovering, setRecovering] = useState(false);
  useEffect(() => {
    let active = true;
    void apiGet<DealChatsDto>(`/openlines/deal-chats/${dealId}`)
      .then(async (d) => {
        const chat = brokenChat(d.items);
        if (!chat || !active) return;
        const channels = await apiGet<ChatChannelDto[]>(`/openlines/chats/${chat.chatId}/channels`).catch(() => []);
        if (active) setBroken({ chat, channels });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [dealId]);
  return (
    <div className="page deal-home">
      <p className="deal-home-caption muted">Сделка #{dealId}</p>
      <nav className="deal-home-tiles" aria-label="Раздел приложения">
        {TILES.map((t) => (
          <button key={t.key} type="button" className={`deal-home-tile ${t.key}`} onClick={() => onOpen(t.key)}>
            <span className="deal-home-icon" aria-hidden="true">
              <Icon name={t.icon} size={34} />
            </span>
            <span className="deal-home-title">{t.title}</span>
            <span className="deal-home-hint">{t.hint}</span>
          </button>
        ))}
        {broken && (
          <button type="button" className="deal-home-tile recover" onClick={() => setRecovering(true)}>
            <span className="deal-home-icon" aria-hidden="true">
              <Icon name="alert" size={34} />
            </span>
            <span className="deal-home-title">Отправить клиенту сообщение</span>
            <span className="deal-home-hint">Канал Wazzup выключен — сообщения не доходят</span>
          </button>
        )}
      </nav>
      {recovering && broken && (
        <div className="sheet-backdrop" onClick={() => setRecovering(false)}>
          <div className="sheet deal-recover" role="dialog" aria-modal="true" aria-label="Отправить клиенту сообщение" onClick={(e) => e.stopPropagation()}>
            <header>
              <h3>Отправить клиенту сообщение</h3>
              <MinimizeButton label="Сообщение клиенту" />
              <button aria-label="Закрыть" onClick={() => setRecovering(false)}>
                ×
              </button>
            </header>
            <ChannelRecovery
              connector={broken.chat.connector}
              channels={broken.channels}
              phones={broken.chat.phones}
              timezone={timezone}
              onOpen={(id) => {
                setRecovering(false);
                onOpenChat(id);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * По сделке уже есть бронь: менеджеру — создать новую сделку с тем же клиентом или игнорировать
 * (открыть календарь). `checking` — брони сделки ещё проверяются.
 */
export function DealBookingWarning({
  booking,
  checking,
  creating,
  error,
  canCreate,
  onCreate,
  onIgnore,
  onClose,
}: {
  booking: string | null;
  checking: boolean;
  creating: boolean;
  error: string;
  canCreate: boolean;
  onCreate: () => void;
  onIgnore: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop deal-warning-backdrop" role="presentation" onClick={onClose}>
      <section className="deal-warning" role="alertdialog" aria-modal="true" aria-labelledby="deal-warning-title" onClick={(e) => e.stopPropagation()}>
        {checking ? (
          <p className="deal-warning-checking" role="status">
            <span className="spinner" aria-hidden="true" /> Проверяем бронирования сделки…
          </p>
        ) : (
          <>
            <span className="deal-warning-icon" aria-hidden="true">
              <Icon name="alert" size={26} />
            </span>
            <h2 id="deal-warning-title">По этой сделке есть бронирование</h2>
            {booking && <p className="deal-warning-booking">{booking}</p>}
            <p className="muted">Для новой брони создайте новую сделку — клиент будет тот же.</p>
            {error && (
              <p className="notice error" role="alert">
                {error}
              </p>
            )}
            <div className="deal-warning-actions">
              {canCreate && (
                <button type="button" className="primary" disabled={creating} onClick={onCreate}>
                  {creating ? 'Создаём сделку…' : 'Создать новую сделку'}
                </button>
              )}
              <button type="button" disabled={creating} onClick={onIgnore}>
                Игнорировать
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
