import { useCallback, useEffect, useState } from 'react';
import type { ChatListDto, ChatScope, ChatSummary, MessageTemplateDto } from '@btx24/shared';
import { apiGet } from '../api.js';
import { ChatView } from './ChatView.js';
import { AUTHOR_PREFIX, connectorLabel, shortTime } from './format.js';

const SCOPES: { key: ChatScope; label: string }[] = [
  { key: 'mine', label: 'Мои' },
  { key: 'department', label: 'Отдел' },
  { key: 'all', label: 'Все доступные' },
];
/** Список чатов обновляем раз в 30 секунд, пока страница открыта. */
const POLL_MS = 30_000;

/** Чаты открытых линий: сверху — с самыми новыми сообщениями. Клик — открыть диалог. */
export function ChatsPage({
  timezone,
  canSend,
  initialChatId,
  initialWaiting = false,
  onClose,
}: {
  timezone: string;
  canSend: boolean;
  initialChatId?: number | null;
  initialWaiting?: boolean;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<ChatScope>('mine');
  const [waitingOnly, setWaitingOnly] = useState(initialWaiting);
  const [list, setList] = useState<{ scope: ChatScope; items: ChatSummary[]; nextOffset: number | null } | null>(null);
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [openId, setOpenId] = useState<number | null>(initialChatId ?? null);
  const [templates, setTemplates] = useState<MessageTemplateDto[] | null>(null);

  const refresh = useCallback(async () => {
    try {
      const page = await apiGet<ChatListDto>(`/openlines/chats?scope=${scope}`);
      setList((prev) => {
        // Обновление первой страницы не теряет подгруженные «ещё».
        if (prev?.scope !== scope) return { scope, ...page };
        const fresh = new Set(page.items.map((c) => c.chatId));
        const tail = prev.items.filter((c) => !fresh.has(c.chatId));
        return {
          scope,
          items: [...page.items, ...tail].sort(byLastMessage),
          nextOffset: prev.nextOffset ?? page.nextOffset,
        };
      });
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить чаты');
    }
  }, [scope]);

  useEffect(() => {
    let active = true;
    void apiGet<ChatListDto>(`/openlines/chats?scope=${scope}`).then(
      (page) => active && setList({ scope, ...page }),
      (e) => active && setError(e instanceof Error ? e.message : 'Не удалось загрузить чаты'),
    );
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [scope, refresh]);

  useEffect(() => {
    if (!canSend) return;
    let active = true;
    void apiGet<MessageTemplateDto[]>('/openlines/templates').then(
      (t) => active && setTemplates(t),
      () => active && setTemplates([]),
    );
    return () => {
      active = false;
    };
  }, [canSend]);

  const more = async () => {
    if (!list?.nextOffset) return;
    setLoadingMore(true);
    try {
      const page = await apiGet<ChatListDto>(`/openlines/chats?scope=${scope}&offset=${list.nextOffset}`);
      const known = new Set(list.items.map((c) => c.chatId));
      setList({
        scope,
        items: [...list.items, ...page.items.filter((c) => !known.has(c.chatId))].sort(byLastMessage),
        nextOffset: page.nextOffset,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить чаты');
    } finally {
      setLoadingMore(false);
    }
  };

  const current = list?.scope === scope ? list : null;
  const items = (current?.items ?? []).filter((c) => !waitingOnly || c.waitingReply);
  const waiting = (current?.items ?? []).filter((c) => c.waitingReply).length;

  return (
    <div className={`chats-page${openId ? ' has-open' : ''}`}>
      <section className="chat-list-pane">
        <header className="chat-list-header">
          <button aria-label="Назад" onClick={onClose}>
            ‹
          </button>
          <h1>Чаты</h1>
          <button aria-label="Обновить" title="Обновить" onClick={() => void refresh()}>
            ↻
          </button>
        </header>
        <div className="segmented" role="group" aria-label="Чьи чаты">
          {SCOPES.map((s) => (
            <button key={s.key} className={scope === s.key ? 'active' : ''} onClick={() => setScope(s.key)}>
              {s.label}
            </button>
          ))}
        </div>
        <label className="check waiting-filter">
          <input type="checkbox" checked={waitingOnly} onChange={(e) => setWaitingOnly(e.target.checked)} />
          Только ждущие ответа{current ? ` (${waiting})` : ''}
        </label>
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        {!current && !error && <p className="muted pad">Загрузка чатов…</p>}
        {current && !items.length && (
          <p className="muted pad">{waitingOnly ? 'Ждущих ответа чатов нет.' : 'Чатов нет.'}</p>
        )}
        <ul className="chat-list">
          {items.map((c) => (
            <li key={c.chatId}>
              <button
                className={`chat-item${openId === c.chatId ? ' active' : ''}`}
                onClick={() => setOpenId(c.chatId)}
              >
                <span className="chat-item-top">
                  <strong>{c.title}</strong>
                  <span className="muted">{c.lastMessage ? shortTime(c.lastMessage.date, timezone) : ''}</span>
                </span>
                <span className="chat-item-preview">
                  {c.lastMessage
                    ? `${AUTHOR_PREFIX[c.lastMessage.author]}${c.lastMessage.preview || (c.lastMessage.hasFiles ? '📎 Файл' : '')}`
                    : 'Нет сообщений'}
                </span>
                <span className="chat-item-tags">
                  <span className="pill">{connectorLabel(c.connector)}</span>
                  {c.waitingReply && <span className="pill waiting">ждёт ответа</span>}
                  {!c.joined && <span className="pill muted-pill">не участвую</span>}
                  {c.sessionClosed && <span className="pill muted-pill">закрыт</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {current?.nextOffset !== null && current && (
          <button className="link more" disabled={loadingMore} onClick={() => void more()}>
            {loadingMore ? 'Загрузка…' : 'Показать ещё'}
          </button>
        )}
      </section>
      {openId ? (
        <ChatView
          key={openId}
          chatId={openId}
          timezone={timezone}
          templates={templates}
          onTemplates={setTemplates}
          onBack={() => setOpenId(null)}
          onChanged={() => void refresh()}
        />
      ) : (
        <section className="chat-view empty-chat muted">Выберите чат слева</section>
      )}
    </div>
  );
}

const byLastMessage = (a: ChatSummary, b: ChatSummary) =>
  (b.lastMessage?.date ?? '').localeCompare(a.lastMessage?.date ?? '');
