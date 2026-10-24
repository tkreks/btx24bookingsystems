import { useCallback, useEffect, useMemo, useState } from 'react';
import { normalizeMessengerPhone, type MessengerClientContextDto, type MessengerChatDto, type MessengerDto, type MessengerMessageDto, type MessengerSendResultDto } from '@btx24/shared';
import { apiBlob, apiDelete, apiGet, apiPost, apiPostForm, apiPut } from '../api.js';
import { fmtDateTime } from '../format.js';
import { MessengerThread, type ThreadApi } from './MessengerThread.js';

/**
 * Переписка номера: ⚙ → «Мессенджеры» → «Чаты» (администратор, `admin`) или «Мессенджеры» в чатах
 * (сотрудник группы номера). Номер привязан к своей линии — сообщения уходят через неё.
 */
export function MessengerChatsDialog({ messenger, timezone, onClose, admin = true, initialChatId }: { initialChatId?: string; messenger: MessengerDto; timezone: string; onClose: () => void; admin?: boolean }) {
  const base = admin ? `/admin/messengers/${messenger.id}` : `/messengers/${messenger.id}`;
  const [chats, setChats] = useState<MessengerChatDto[] | null>(null);
  const [current, setCurrent] = useState<string | null>(initialChatId ?? null);
  const [newPhone, setNewPhone] = useState('');
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const [context, setContext] = useState<{ chat: string; data: MessengerClientContextDto } | null>(null);
  const [dealView, setDealView] = useState<{ chat: string; value: string }>({ chat: '', value: 'all' });
  const [choosing, setChoosing] = useState(false);
  const ctx = context?.chat === current ? context.data : null;
  const view = dealView.chat === current ? dealView.value : 'all';
  const selectedDealId = ctx?.activeDealId;
  const contextReady = ctx !== null;
  useEffect(() => {
    if (!current) return;
    let alive = true;
    const refresh = () => apiGet<MessengerClientContextDto>(`${base}/chats/${encodeURIComponent(current)}/context`).then(data => { if (alive) setContext({ chat: current, data }); }, e => { if (alive) setError(e instanceof Error ? e.message : 'Не удалось проверить CRM'); });
    void refresh(); const timer = setInterval(() => void refresh(), 15_000);
    return () => { alive = false; clearInterval(timer); };
  }, [base, current]);
  const choose = async (value: string) => {
    if (!current) return;
    setChoosing(true);
    try {
      const data = await apiPut<MessengerClientContextDto>(`${base}/chats/${encodeURIComponent(current)}/deal`, { dealId: Number(value) });
      setContext({ chat: current, data }); setDealView({ chat: current, value }); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось выбрать сделку'); }
    finally { setChoosing(false); }
  };


  const load = useCallback(
    () => apiGet<MessengerChatDto[]>(`${base}/chats`).then(setChats, (e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить чаты')),
    [base],
  );
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const api = useMemo<ThreadApi | null>(() => {
    if (!current) return null;
    const chat = encodeURIComponent(current);
    return {
      load: (before) => { const q = new URLSearchParams(); if (before) q.set('before', before); if (view !== 'all') q.set('dealId', view); return apiGet<MessengerMessageDto[]>(`${base}/chats/${chat}/messages?${q}`); },
      media: (id) => apiBlob(`${base}/messages/${encodeURIComponent(id)}/media`),
      sendFile: async (file, text) => {
        const form = new FormData(); form.append('file', file, file.name); form.append('to', current); form.append('text', text); if (contextReady) form.append('dealId', selectedDealId == null ? 'general' : String(selectedDealId));
        const result = await apiPostForm<MessengerSendResultDto>(`${base}/send-file`, form);
        if (result.message && result.message.chatId !== current) setCurrent(result.message.chatId);
        void load();
        return result.message;
      },
      send: async (text) => {
        const result = await apiPost<MessengerSendResultDto>(`${base}/send`, { to: current, text, dealId: selectedDealId ?? null });
        if (result.message && result.message.chatId !== current) setCurrent(result.message.chatId);
        void load();
        return result.message;
      },
      edit: (id, text) => apiPost<MessengerMessageDto>(`${base}/messages/${encodeURIComponent(id)}/edit`, { text }),
      remove: (id) => apiDelete<MessengerMessageDto>(`${base}/messages/${encodeURIComponent(id)}`),
    };
  }, [base, current, view, selectedDealId, contextReady, load]);

  const startNew = () => {
    const phone = normalizeMessengerPhone(newPhone);
    if (!phone) return setError('Номер: 10–15 цифр с кодом страны');
    setError('');
    setCurrent(chats?.find(c => normalizeMessengerPhone(c.phone) === phone)?.chatId ?? `${phone}@c.us`);
    setNewPhone('');
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet messenger-chats" role="dialog" aria-modal="true" aria-label="Чаты мессенджера" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Чаты · +{messenger.phone}</h2>
          {admin && (
          <button
            type="button"
            disabled={importing || messenger.state !== 'ready'}
            onClick={() => {
              setImporting(true);
              apiPost<{ messages: number }>(`${base}/import`, {})
                .then((r) => {
                  setError('');
                  void load();
                  alert(`Загружено сообщений: ${r.messages}`);
                }, (e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить историю'))
                .finally(() => setImporting(false));
            }}
          >
            {importing ? 'Загружаем…' : 'Загрузить историю'}
          </button>
          )}
          <button type="button" aria-label="Закрыть" onClick={onClose}>
            ×
          </button>
        </header>
        {error && <div className="notice error" role="alert">{error}</div>}
        {messenger.line && <p className="notice">Номер подключён к открытой линии «{messenger.line.name ?? messenger.line.lineId}»: сообщения уходят через неё и видны в Битрикс24.</p>}
        <div className="mc-layout">
          <aside className="mc-list">
            <form
              className="mc-new"
              onSubmit={(e) => {
                e.preventDefault();
                startNew();
              }}
            >
              <input type="tel" placeholder="Написать по номеру" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} />
              <button disabled={!newPhone.trim()}>→</button>
            </form>
            {chats === null && <p className="muted pad">Загрузка…</p>}
            {chats?.length === 0 && <p className="muted pad">Переписки пока нет. Нажмите «Загрузить историю» или напишите по номеру.</p>}
            <ul>
              {chats?.map((c) => (
                <li key={c.chatId}>
                  <button type="button" className={current === c.chatId ? 'active' : ''} onClick={() => setCurrent(c.chatId)}>
                    <b>{c.name || (c.phone ? `+${c.phone}` : c.chatId)}</b>
                    {c.unread > 0 && <span className="mc-unread">{c.unread}</span>}
                    <span className="muted mc-last">{c.lastText}</span>
                    {c.lastMessageAt && <span className="muted mc-time">{fmtDateTime(c.lastMessageAt, timezone)}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </aside>
          <section className="mc-thread">
            {current && <div className="mc-context">
              {ctx ? <>
                {!!ctx.contacts.length && <div>{ctx.contacts.map(c => c.name).join(', ')}</div>}
                <label>Текущая сделка <select aria-label="Текущая сделка" value={ctx.activeDealId ?? ''} disabled={choosing || !ctx.deals.some(d => d.active)} onChange={e => void choose(e.target.value)}>
                  <option value="" disabled>{ctx.deals.some(d => d.active) ? 'Выберите сделку' : 'Активных сделок нет'}</option>
                  {ctx.deals.filter(d => d.active).map(d => <option value={d.id} key={d.id}>#{d.id} · {d.title}</option>)}
                </select></label>
                {messenger.line && ctx.activeDealId && <button type="button" disabled={choosing} onClick={() => void choose(String(ctx.activeDealId))}>Работать в этом канале</button>}
                {ctx.needsChoice && <p className="notice">У клиента несколько сделок. Выберите, к какой относится обращение.</p>}
                {!!ctx.pending && <p className="muted">Ожидают выбора сделки: {ctx.pending}</p>}
                <label>История <select aria-label="История по сделке" value={view} onChange={e => setDealView({ chat: current, value: e.target.value })}>
                  <option value="all">Вся переписка</option><option value="general">Без сделки / ожидает выбора</option>
                  {ctx.deals.map(d => <option key={d.id} value={d.id}>#{d.id} · {d.title}{d.active ? '' : ' · завершена'}</option>)}
                </select></label>
                {ctx.note && <small className="muted">{ctx.note}</small>}
              </> : <span className="muted">Проверяем контакт и сделки в CRM…</span>}
            </div>}

            {api ? (
              <MessengerThread key={`${current}:${view}`} api={api} timezone={timezone} kind={messenger.kind} canSend={!!ctx && !ctx.needsChoice && !choosing && (view === 'all' || view === (ctx.activeDealId == null ? 'general' : String(ctx.activeDealId))) && (admin ? messenger.state === 'ready' : true)} label="WhatsApp" />
            ) : (
              <p className="muted pad">Выберите чат слева.</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
