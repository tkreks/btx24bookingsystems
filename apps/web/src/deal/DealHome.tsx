import { useEffect, useState } from 'react';
import { normalizeMessengerPhone, type AttentionChatDto, type ChatFlagDto, type ChatSummary, type DealChatsDto } from '@btx24/shared';
import { apiGet, apiPut } from '../api.js';
import { openCrm } from '../b24.js';
import { AttentionMessage } from '../dashboard/AttentionMessage.js';
import { MessengerSearchButton } from '../messengers/MessengerSearchButton.js';
import { hasDisabledWazzupChannel } from '../openlines/channel-error.js';
import { HideChatDialog } from '../openlines/DashboardPage.js';
import { Icon, type IconName } from '../openlines/icons.js';

export type DealHomeTarget = 'chats' | 'calendar' | 'booking';

const TILES: { key: Exclude<DealHomeTarget, 'chats'>; icon: IconName; title: string; hint: string }[] = [
  { key: 'calendar', icon: 'calendar', title: 'Календарь', hint: 'Брони ресурсов по дням' },
  { key: 'booking', icon: 'plus', title: 'Новая бронь', hint: 'Мастер бронирования по сделке' },
];
/** Чатов в блоке; остальные — «Все чаты». */
const CHATS_SHOWN = 3;

/** Чат клиента сделки, где Wazzup сообщил «канал выключен» (по последнему сообщению). */
export function brokenChat(items: ChatSummary[]): ChatSummary | null {
  return items.find((c) => hasDisabledWazzupChannel(c.connector, c.lastMessage?.preview)) ?? null;
}

/** Чат клиента — строкой «Последних сообщений» дашборда. */
export function chatRow(c: ChatSummary): AttentionChatDto {
  return {
    chatId: c.chatId,
    unread: c.unread,
    title: c.title,
    clientName: c.clientName,
    clientAvatar: c.clientAvatar ?? null,
    connector: c.connector,
    lastMessageAt: c.lastMessage?.date ?? '',
    preview: c.lastMessage?.preview ?? '',
    hasFiles: c.lastMessage?.hasFiles ?? false,
    dealId: c.crm.dealId,
    contactId: c.crm.contactId,
    responsibleId: c.responsibleId,
    flag: c.flag ?? null,
  };
}

/**
 * Встройка сделки (решение владельца 2026-10-26): блок «Чат с клиентом» — число чатов и строки как в
 * «Последних сообщениях» дашборда (те же кнопки), ниже — «Календарь» и «Новая бронь» (мастер брони).
 * Ошибка канала Wazzup — предупреждение в блоке чата и сразу поиск клиента по мессенджерам.
 */
export function DealHome({ dealId, timezone, canBook, onOpen, onOpenChat }: { dealId: number; timezone: string; /** Право создавать брони (проверит и сервер). */ canBook: boolean; onOpen: (target: DealHomeTarget) => void; onOpenChat: (chatId: number) => void }) {
  const [data, setData] = useState<DealChatsDto | null>(null);
  const [error, setError] = useState('');
  const [hiding, setHiding] = useState<AttentionChatDto | null>(null);
  const [flagError, setFlagError] = useState('');
  useEffect(() => {
    let active = true;
    void apiGet<DealChatsDto>(`/openlines/deal-chats/${dealId}`).then(
      (d) => active && setData(d),
      (e) => active && setError(e instanceof Error ? e.message : 'Чаты клиента недоступны'),
    );
    return () => {
      active = false;
    };
  }, [dealId]);
  const items = data?.items ?? [];
  const broken = brokenChat(items);
  const phone = broken ? broken.phones.map((p) => normalizeMessengerPhone(p)).find((p): p is string => !!p) ?? null : null;
  const toggleFlag = (c: AttentionChatDto) =>
    apiPut<ChatFlagDto>(`/openlines/chats/${c.chatId}/flag`, { on: !c.flag }).then(
      (r) => {
        setFlagError('');
        setData((d) => (d ? { ...d, items: d.items.map((x) => (x.chatId === r.chatId ? { ...x, flag: r.flag } : x)) } : d));
      },
      (e) => setFlagError(e instanceof Error ? e.message : 'Не удалось поставить «!»'),
    );
  return (
    <div className="page deal-home">
      <p className="deal-home-caption muted">Сделка #{dealId}</p>
      <section className="day-panel dash-block dash-attention deal-home-chats">
        <header className="deal-home-chats-head">
          <h2>Чат с клиентом</h2>
          {data && <span className="pill">{items.length}</span>}
          {items.length > 0 && (
            <button type="button" className="link" onClick={() => onOpen('chats')}>
              Все чаты
            </button>
          )}
        </header>
        {!data && !error && <p className="muted">Загрузка чатов…</p>}
        {error && <p className="notice error" role="alert">{error}</p>}
        {flagError && <p className="notice error" role="alert">{flagError}</p>}
        {data && !items.length && <p className="muted">Чатов с клиентом сделки нет.</p>}
        {broken && (
          <div className="deal-home-broken" role="alert">
            <Icon name="alert" size={18} />
            <span>
              <b>Канал Wazzup выключен</b> — сообщения клиенту не доходят.{' '}
              {phone ? 'Ищем клиента в мессенджерах:' : 'Номера клиента нет — поиск в мессенджерах недоступен.'}
            </span>
            {phone && <MessengerSearchButton phone={phone} timezone={timezone} onOpenChat={onOpenChat} autoStart />}
          </div>
        )}
        <ul className="attention-rows">
          {items.slice(0, CHATS_SHOWN).map((s) => {
            const c = chatRow(s);
            return (
              <li key={c.chatId} className={c.flag ? 'flagged' : undefined}>
                <AttentionMessage chat={c} timezone={timezone} onOpen={() => onOpenChat(c.chatId)} />
                <span className="attention-actions">
                  <button
                    className={`dash-icon-btn cl-flag${c.flag ? ' on' : ''}`}
                    aria-pressed={!!c.flag}
                    title={c.flag ? `«!» — ${c.flag.byName ?? 'сотрудник'}; снимется, когда менеджер ответит клиенту. Нажмите — снять` : '«!» — видно всем, пока менеджер не ответит клиенту'}
                    aria-label={c.flag ? 'Снять «!»' : 'Отметить «!»'}
                    onClick={() => void toggleFlag(c)}
                  >
                    !
                  </button>
                  <button className="dash-icon-btn" title={c.dealId ? `Сделка #${c.dealId}` : 'Чат не привязан к сделке'} aria-label="Открыть сделку" disabled={!c.dealId} onClick={() => c.dealId && openCrm('deal', c.dealId)}>
                    <Icon name="deal" size={18} />
                  </button>
                  <button className="dash-icon-btn" title="Перейти в чат" aria-label="Перейти в чат" onClick={() => onOpenChat(c.chatId)}>
                    <Icon name="gochat" size={18} />
                  </button>
                  <button className="dash-icon-btn" title="Скрыть чат с дашборда" aria-label="Скрыть чат с дашборда" onClick={() => setHiding(c)}>
                    <Icon name="hide" size={18} />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
        {items.length > CHATS_SHOWN && (
          <button type="button" className="link deal-home-more" onClick={() => onOpen('chats')}>
            Ещё чатов: {items.length - CHATS_SHOWN}
          </button>
        )}
      </section>
      <nav className="deal-home-tiles" aria-label="Бронирование">
        {TILES.filter((t) => t.key !== 'booking' || canBook).map((t) => (
          <button key={t.key} type="button" className={`deal-home-tile ${t.key}`} onClick={() => onOpen(t.key)}>
            <span className="deal-home-icon" aria-hidden="true">
              <Icon name={t.icon} size={34} />
            </span>
            <span className="deal-home-title">{t.title}</span>
            <span className="deal-home-hint">{t.hint}</span>
          </button>
        ))}
      </nav>
      {hiding && <HideChatDialog chat={hiding} onClose={() => setHiding(null)} onHidden={() => setHiding(null)} />}
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
