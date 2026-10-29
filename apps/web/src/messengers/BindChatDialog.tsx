import { useEffect, useRef, useState } from 'react';
import { messengerLabel, type MessengerBindChatsDto, type MessengerBindResultDto, type MessengerDto, type MessengerKind } from '@btx24/shared';
import { apiGet, apiPost } from '../api.js';
import { openCrm } from '../b24.js';
import { fmtWhen } from '../format.js';
import { fmtLinePhone } from '../openlines/ChannelFilter.js';
import { MessengerKindIcon } from './MessengerSearchButton.js';

const KINDS: MessengerKind[] = ['whatsapp', 'telegram', 'max'];

/**
 * «Привязать чат» (встройка сделки): чат из мессенджера — клиенту этой сделки. Шаги: мессенджер →
 * номер (если подключено несколько) → последние 10 чатов номера, «Загрузить ещё», поиск по всем чатам
 * номера. Чат уже у другого клиента или у клиента другие сделки — сервер скажет, что объединить.
 */
export function BindChatDialog({ dealId, timezone, onBound, onClose }: { dealId: number; timezone: string; onBound: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [messengers, setMessengers] = useState<MessengerDto[] | null>(null);
  const [error, setError] = useState('');
  const [kind, setKind] = useState<MessengerKind | null>(null);
  const [account, setAccount] = useState<MessengerDto | null>(null);
  useEffect(() => ref.current?.showModal(), []);
  useEffect(() => {
    let alive = true;
    apiGet<MessengerDto[]>('/messengers').then(
      (v) => alive && setMessengers(v),
      (e) => alive && setError(e instanceof Error ? e.message : 'Мессенджеры недоступны'),
    );
    return () => {
      alive = false;
    };
  }, []);

  const kinds = KINDS.filter((k) => messengers?.some((m) => m.kind === k));
  const accounts = (messengers ?? []).filter((m) => m.kind === kind);
  // Один мессенджер / один номер — шаг выбора пропускаем.
  useEffect(() => {
    if (!kind && kinds.length === 1) setKind(kinds[0]);
  }, [kind, kinds]);
  useEffect(() => {
    if (kind && !account && accounts.length === 1) setAccount(accounts[0]);
  }, [kind, account, accounts]);

  const back = account && accounts.length > 1 ? () => setAccount(null) : kind && kinds.length > 1 ? () => (setAccount(null), setKind(null)) : null;
  return (
    <dialog ref={ref} className="new-dialog bind-chat" aria-label="Привязать чат" onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => e.stopPropagation()}>
      <header className="new-dialog-head">
        {back && <button type="button" className="cl-btn" aria-label="Назад" onClick={back}>←</button>}
        <h3>{account ? `Привязать чат · ${messengerLabel(account.kind)} ${fmtLinePhone(account.phone)}` : kind ? `${messengerLabel(kind)}: какой номер?` : 'Привязать чат: какой мессенджер?'}</h3>
        <button type="button" className="new-dialog-close" aria-label="Закрыть" onClick={onClose}>×</button>
      </header>
      {!messengers && !error && <p className="muted"><span className="spinner" aria-hidden="true" /> Загружаем мессенджеры…</p>}
      {error && <p className="notice error" role="alert">{error}</p>}
      {messengers && !kinds.length && <p className="muted">Нет доступных вам подключённых мессенджеров.</p>}
      {!kind && kinds.length > 1 && (
        <ul className="new-dialog-checks">
          {kinds.map((k) => (
            <li key={k} className="new-dialog-check found">
              <MessengerKindIcon kind={k} size={30} />
              <span className="new-dialog-check-name"><b>{messengerLabel(k)}</b><span className="muted">номеров: {messengers!.filter((m) => m.kind === k).length}</span></span>
              <button type="button" className="primary new-dialog-start" onClick={() => setKind(k)}>Выбрать</button>
            </li>
          ))}
        </ul>
      )}
      {kind && !account && accounts.length > 1 && (
        <ul className="new-dialog-checks">
          {accounts.map((m) => (
            <li key={m.id} className="new-dialog-check found">
              <MessengerKindIcon kind={m.kind} size={30} />
              <span className="new-dialog-check-name"><b>{m.title || messengerLabel(m.kind)}</b><span className="muted">{fmtLinePhone(m.phone)}</span></span>
              <button type="button" className="primary new-dialog-start" onClick={() => setAccount(m)}>Выбрать</button>
            </li>
          ))}
        </ul>
      )}
      {account && <BindChatList key={account.id} messenger={account} dealId={dealId} timezone={timezone} onBound={onBound} />}
    </dialog>
  );
}

function BindChatList({ messenger, dealId, timezone, onBound }: { messenger: MessengerDto; dealId: number; timezone: string; onBound: () => void }) {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<MessengerBindChatsDto['items']>([]);
  const [more, setMore] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [binding, setBinding] = useState<string | null>(null);
  const [result, setResult] = useState<MessengerBindResultDto | null>(null);

  // Поиск — по всем чатам номера, с паузой после ввода.
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);
  const load = (offset: number) => {
    setLoading(true);
    return apiGet<MessengerBindChatsDto>(`/messengers/${encodeURIComponent(messenger.id)}/bind-chats?offset=${offset}${query ? `&q=${encodeURIComponent(query)}` : ''}`).then(
      (r) => {
        setItems((prev) => (offset ? [...prev, ...r.items] : r.items));
        setMore(r.hasMore ? r.nextOffset : null);
        setError('');
      },
      (e) => setError(e instanceof Error ? e.message : 'Чаты недоступны'),
    ).finally(() => setLoading(false));
  };
  useEffect(() => {
    void load(0);
    // Перезагрузка — только при смене поиска.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const bind = async (chatId: string) => {
    setBinding(chatId);
    setError('');
    try {
      const r = await apiPost<MessengerBindResultDto>(`/messengers/${encodeURIComponent(messenger.id)}/chats/${encodeURIComponent(chatId)}/bind`, { dealId });
      setResult(r);
      if (r.linked) onBound();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось привязать чат');
    } finally {
      setBinding(null);
    }
  };

  if (result)
    return (
      <div className={`bind-result${result.linked ? ' ok' : ' merge'}`} role="status">
        <p><b>{result.linked ? 'Готово.' : 'Не привязано.'}</b> {result.message}</p>
        {!!result.merge?.contacts.length && (
          <p>Контакты: {result.merge.contacts.map((c, i) => <span key={c.id}>{i ? ', ' : ''}<button type="button" className="link" onClick={() => openCrm('contact', c.id)}>{c.name}</button></span>)}</p>
        )}
        {!!result.merge?.deals.length && (
          <p>Сделки: {result.merge.deals.map((d, i) => <span key={d.id}>{i ? ', ' : ''}<button type="button" className="link" onClick={() => openCrm('deal', d.id)}>{d.title}</button></span>)}</p>
        )}
        <footer className="form-actions"><button type="button" onClick={() => setResult(null)}>К списку чатов</button></footer>
      </div>
    );
  return (
    <div className="bind-chat-list">
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск по всем чатам номера: имя или телефон" aria-label="Поиск чата" autoFocus />
      {error && <p className="notice error" role="alert">{error}</p>}
      <ul className="new-dialog-checks">
        {items.map((c) => (
          <li key={c.chatId} className="new-dialog-check found">
            <span className="new-dialog-check-name">
              <b>{c.name || (c.phone ? `+${c.phone}` : c.chatId)}</b>
              <span className="muted">
                {c.phone && c.name ? `+${c.phone} · ` : ''}
                {c.lastMessageAt ? fmtWhen(c.lastMessageAt, timezone) : 'нет сообщений'}
                {c.contactId ? ` · связан с контактом #${c.contactId}` : ''}
              </span>
              {c.lastText && <span className="muted bind-chat-preview">{c.lastText}</span>}
            </span>
            <button type="button" className="primary new-dialog-start" disabled={!!binding} onClick={() => void bind(c.chatId)}>
              {binding === c.chatId ? 'Привязываем…' : 'Привязать'}
            </button>
          </li>
        ))}
      </ul>
      {loading && <p className="muted"><span className="spinner" aria-hidden="true" /> Загрузка чатов…</p>}
      {!loading && !items.length && !error && <p className="muted">{query ? 'Ничего не найдено.' : 'В этом номере ещё нет чатов.'}</p>}
      {more !== null && !loading && <button type="button" className="link" onClick={() => void load(more)}>Загрузить ещё</button>}
    </div>
  );
}
