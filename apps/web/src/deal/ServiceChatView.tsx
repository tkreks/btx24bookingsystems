import { Fragment, useEffect, useRef, useState } from 'react';
import { SERVICE_CHAT_SOURCES, type ServiceChatDto, type ServiceChatMessageDto } from '@btx24/shared';
import { apiGet, apiPost } from '../api.js';
import { fmtDayTitle, fmtTime } from '../format.js';
import { dayKey } from '../openlines/chat-list.js';
import { Icon } from '../openlines/icons.js';

/**
 * Служебный чат сделки: клиент без мессенджеров. Только в приложении — в Битрикс24 ничего не уходит.
 * Сюда пишет автоматика (ссылки на оплату, подтверждения), сотрудники оставляют заметки. Сверху —
 * поиск клиента в мессенджерах и «Привязать чат»: как только переписка появится, писать — туда.
 */
export function ServiceChatView({ dealId, timezone, onBack, onFind, onBind }: { dealId: number; timezone: string; onBack?: () => void; onFind: () => void; onBind: () => void }) {
  const [data, setData] = useState<ServiceChatDto | null>(null);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const load = () =>
    apiGet<ServiceChatDto>(`/deals/${dealId}/service-chat`).then(
      (d) => (setData(d), setError('')),
      (e) => setError(e instanceof Error ? e.message : 'Служебный чат недоступен'),
    );
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealId]);
  const count = data?.messages.length ?? 0;
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [count]);

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      const m = await apiPost<ServiceChatMessageDto>(`/deals/${dealId}/service-chat/messages`, { text: body });
      setData((d) => (d ? { ...d, messages: [...d.messages, m] } : d));
      setText('');
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось записать');
    } finally {
      setBusy(false);
    }
  };

  const messages = data?.messages ?? [];
  return (
    <main className="chat-view service-chat">
      <header className="cv-head">
        <div className="cv-contact-line">
          {onBack && (
            <button className="cl-btn chat-back" aria-label="К списку чатов" title="К чатам" onClick={onBack}>
              <Icon name="back" />
            </button>
          )}
          <span className="service-chat-badge" aria-hidden="true">
            <Icon name="settings" size={18} />
          </span>
          <span className="cv-title">
            <b>Служебный чат</b>
            <span className="muted">Только в приложении · клиенту не отправляется</span>
          </span>
          <span className="service-chat-actions">
            <button type="button" className="cl-btn" onClick={onFind} title="Найти клиента в мессенджерах и начать переписку">Найти в мессенджерах</button>
            <button type="button" className="cl-btn" onClick={onBind} title="Привязать к клиенту чат из мессенджера">Привязать чат</button>
          </span>
        </div>
      </header>
      <div className="cv-conversation" ref={list} aria-live="polite" aria-label="Сообщения служебного чата">
        {!data && !error && <p className="muted pad"><span className="spinner" aria-hidden="true" /> Загрузка…</p>}
        {data && !messages.length && (
          <div className="cv-system muted">Сообщений пока нет. Сюда придут ссылки на оплату и подтверждения, пока у клиента нет чата в мессенджере.</div>
        )}
        {messages.map((m, i) => {
          const day = dayKey(m.createdAt, timezone);
          const newDay = i === 0 || dayKey(messages[i - 1].createdAt, timezone) !== day;
          return (
            <Fragment key={m.id}>
              {newDay && <div className="cv-date">{fmtDayTitle(day, timezone)}</div>}
              <div className={`service-chat-msg ${m.source}`}>
                <span className="service-chat-meta muted">
                  {m.authorName ?? SERVICE_CHAT_SOURCES[m.source]} · {fmtTime(m.createdAt, timezone)}
                </span>
                <div className="service-chat-text">{m.text}</div>
              </div>
            </Fragment>
          );
        })}
      </div>
      {error && <div className="notice error" role="alert">{error}</div>}
      <div className="composer cv-composer">
        <div className="cv-composer-row">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send();
            }}
            rows={2}
            placeholder="Заметка в служебный чат (клиенту не отправляется)"
            aria-label="Заметка"
            disabled={busy}
          />
          <div className="cv-composer-side">
            <button className="primary" disabled={busy || !text.trim()} onClick={() => void send()} title="Ctrl+Enter — записать">
              {busy ? 'Запись…' : 'Записать'}
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
