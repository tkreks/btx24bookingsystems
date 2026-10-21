import { useEffect, useState } from 'react';
import type { ChatListDto, DashboardDto, DashboardPeriod, SessionInfo } from '@btx24/shared';
import { apiGet } from '../api.js';
import { AUTHOR_PREFIX, connectorLabel, shortTime } from './format.js';

const PERIODS: { key: DashboardPeriod; label: string }[] = [
  { key: 'today', label: 'Сегодня' },
  { key: '7d', label: '7 дней' },
  { key: '30d', label: '30 дней' },
];

/** Дашборд менеджера: его показатели в рамках его прав; вход в чаты. */
export function DashboardPage({
  session,
  openlines,
  onBack,
  onChats,
}: {
  session: SessionInfo;
  openlines: boolean;
  onBack: () => void;
  onChats: (opts: { chatId?: number; waiting?: boolean }) => void;
}) {
  const [period, setPeriod] = useState<DashboardPeriod>('today');
  const [data, setData] = useState<{ period: DashboardPeriod; dto: DashboardDto } | null>(null);
  const [recent, setRecent] = useState<ChatListDto | null>(null);
  const [error, setError] = useState('');
  const tz = session.portal.timezone;

  useEffect(() => {
    let active = true;
    apiGet<DashboardDto>(`/dashboard?period=${period}`).then(
      (dto) => {
        if (active) {
          setData({ period, dto });
          setError('');
        }
      },
      (e) => active && setError(e instanceof Error ? e.message : 'Не удалось загрузить дашборд'),
    );
    return () => {
      active = false;
    };
  }, [period]);

  useEffect(() => {
    if (!openlines) return;
    let active = true;
    apiGet<ChatListDto>('/openlines/chats?scope=mine').then(
      (l) => active && setRecent(l),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [openlines]);

  const d = data?.period === period ? data.dto : null;
  const n = (v: number | null | undefined) => (v === null || v === undefined ? '—' : String(v));

  return (
    <div className="page dashboard">
      <header className="toolbar">
        <div className="toolbar-title">
          <button aria-label="К календарю" onClick={onBack}>
            ‹
          </button>
          <h1>Мой дашборд</h1>
          <span className="muted">{session.user.name}</span>
        </div>
        <div className="segmented" role="group" aria-label="Период">
          {PERIODS.map((p) => (
            <button key={p.key} className={period === p.key ? 'active' : ''} onClick={() => setPeriod(p.key)}>
              {p.label}
            </button>
          ))}
        </div>
      </header>

      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}

      <div className={`tiles${d ? '' : ' loading'}`}>
        {openlines && (
          <>
            <button className="tile accent" onClick={() => onChats({ waiting: true })}>
              <span className="tile-value">{n(d?.chats?.waitingReply)}</span>
              <span className="tile-label">Чатов ждут ответа</span>
            </button>
            <div className="tile">
              <span className="tile-value">{n(d?.chats?.unreadMessages)}</span>
              <span className="tile-label">Непрочитанных сообщений</span>
            </div>
            <div className="tile">
              <span className="tile-value">{n(d?.contacts?.leads)}</span>
              <span className="tile-label">Лидов — было общение</span>
            </div>
            <div className="tile">
              <span className="tile-value">{n(d?.contacts?.contacts)}</span>
              <span className="tile-label">Контактов — было общение</span>
            </div>
            <div className="tile">
              <span className="tile-value">{n(d?.contacts?.deals)}</span>
              <span className="tile-label">Сделок — было общение</span>
            </div>
          </>
        )}
        <div className="tile" title="Считается по броням, созданным через приложение">
          <span className="tile-value">{n(d?.bookings.created)}</span>
          <span className="tile-label">Создано броней</span>
        </div>
        <div className="tile" title="Считается по отменам через приложение">
          <span className="tile-value">{n(d?.bookings.cancelled)}</span>
          <span className="tile-label">Отменено броней</span>
        </div>
      </div>
      {d && d.bookings.created === null && (
        <p className="muted">
          Брони начнут учитываться, когда их создание и отмена заработают в приложении: в Битрикс24 у брони нет автора и
          даты создания.
        </p>
      )}

      {openlines ? (
        <section className="day-panel">
          <div className="day-header">
            <b>Чаты</b>
            <button className="primary" onClick={() => onChats({})}>
              Открыть чаты
            </button>
          </div>
          {!recent && <p className="muted">Загрузка…</p>}
          <ul className="chat-list">
            {recent?.items.slice(0, 5).map((c) => (
              <li key={c.chatId}>
                <button className="chat-item" onClick={() => onChats({ chatId: c.chatId })}>
                  <span className="chat-item-top">
                    <strong>{c.title}</strong>
                    <span className="muted">{c.lastMessage ? shortTime(c.lastMessage.date, tz) : ''}</span>
                  </span>
                  <span className="chat-item-preview">
                    {c.lastMessage ? `${AUTHOR_PREFIX[c.lastMessage.author]}${c.lastMessage.preview}` : 'Нет сообщений'}
                  </span>
                  <span className="chat-item-tags">
                    <span className="pill">{connectorLabel(c.connector)}</span>
                    {c.waitingReply && <span className="pill waiting">ждёт ответа</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {recent && !recent.items.length && <p className="muted">Своих диалогов пока нет.</p>}
        </section>
      ) : (
        <p className="notice">Открытые линии недоступны: в ваших группах не включено право на них.</p>
      )}
    </div>
  );
}
