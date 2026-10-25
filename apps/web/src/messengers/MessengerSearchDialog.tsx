import { useEffect, useRef, useState } from 'react';
import { messengerLabel, type MessengerContactSearchDto } from '@btx24/shared';
import { apiGet } from '../api.js';
import { openMessenger } from '../b24.js';
import { groupByKind, KIND_STATE_LABEL, StartChatFlow, type SearchResult } from './by-kind.js';

/** Проверка доступных каналов без пробного сообщения клиенту; `initial` — уже готовый результат (без повторного поиска). */
export function MessengerSearchDialog({ phone, timezone, onClose, onOpenChat, initial, connectedOnly = false }: { phone: string; timezone: string; onClose: () => void; onOpenChat?: (id: number) => void; initial?: MessengerContactSearchDto | null; connectedOnly?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<MessengerContactSearchDto | null>(initial ?? null);
  const [error, setError] = useState('');
  const [writing, setWriting] = useState<SearchResult[] | null>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  useEffect(() => {
    if (initial) return;
    let alive = true;
    apiGet<MessengerContactSearchDto>(`/messengers/search?phone=${encodeURIComponent(phone)}`).then(d => { if (alive) setData(d); }, e => { if (alive) setError(e instanceof Error ? e.message : 'Не удалось проверить мессенджеры'); });
    return () => { alive = false; };
  }, [phone, initial]);
  // Восстановление после ошибки чужого провайдера: только собственные работающие линии.
  const results = data?.results.filter(r => !connectedOnly || (r.messenger.line?.mode === 'own' && r.messenger.state === 'ready')) ?? [];
  // Строка на мессенджер, не на аккаунт; несколько аккаунтов — выбор при «Написать».
  const kinds = groupByKind(results.map(r => r.messenger), results);
  return <dialog ref={ref} className="messenger-search-dialog" aria-label="Поиск в мессенджерах" onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => e.stopPropagation()}>
    <header><h3>Поиск в мессенджерах</h3><button type="button" aria-label="Закрыть поиск" onClick={onClose}>×</button></header>
    <p className="muted">{phone}</p>
    {error && <p role="alert" className="notice error">{error}</p>}
    {!data && !error && <p role="status">Проверяем доступные мессенджеры…</p>}
    {data && !results.length && <p>{connectedOnly ? 'Нет работающих собственных подключений ОЛ, доступных вам по группам.' : 'Нет подключённых мессенджеров, доступных вам по группам.'}</p>}
    {!connectedOnly && !!data?.existingChats?.length && <section><h4>Продолжить существующий диалог</h4>{data.existingChats.map(c => <button type="button" key={c.chatId} onClick={() => { onClose(); if (onOpenChat) onOpenChat(c.chatId); else openMessenger(c.chatId); }}>{c.title}</button>)}</section>}
    {!!results.length && <h4>Написать в мессенджер</h4>}
    {kinds.map(k => <div className="messenger-search-result" key={k.kind}>
      <div><b>{messengerLabel(k.kind)}{k.accounts.length > 1 ? ` · аккаунтов: ${k.accounts.length}` : ` · +${k.accounts[0].phone}`}</b><p>{KIND_STATE_LABEL[k.state]}</p>{k.note && <small className="muted">{k.note}</small>}</div>
      {k.state === 'found' && <button type="button" className="primary" onClick={() => setWriting(k.found)}>Написать</button>}
    </div>)}
    {writing && <StartChatFlow found={writing} phone={data?.phone ?? null} timezone={timezone} onOpenChat={id => { onClose(); if (onOpenChat) onOpenChat(id); else openMessenger(id); }} onClose={() => setWriting(null)} />}
  </dialog>;
}
