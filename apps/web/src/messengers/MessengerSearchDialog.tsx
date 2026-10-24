import { useEffect, useRef, useState } from 'react';
import type { MessengerContactSearchDto } from '@btx24/shared';
import { apiGet } from '../api.js';
import { openMessenger } from '../b24.js';
import { MessengerChatsDialog } from './MessengerChatsDialog.js';

/** Проверка доступных каналов без пробного сообщения клиенту; `initial` — уже готовый результат (без повторного поиска). */
export function MessengerSearchDialog({ phone, timezone, onClose, onOpenChat, initial }: { phone: string; timezone: string; onClose: () => void; onOpenChat?: (id: number) => void; initial?: MessengerContactSearchDto | null }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<MessengerContactSearchDto | null>(initial ?? null);
  const [error, setError] = useState('');
  const [writing, setWriting] = useState<MessengerContactSearchDto['results'][number] | null>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  useEffect(() => {
    if (initial) return;
    let alive = true;
    apiGet<MessengerContactSearchDto>(`/messengers/search?phone=${encodeURIComponent(phone)}`).then(d => { if (alive) setData(d); }, e => { if (alive) setError(e instanceof Error ? e.message : 'Не удалось проверить мессенджеры'); });
    return () => { alive = false; };
  }, [phone, initial]);
  return <dialog ref={ref} className="messenger-search-dialog" aria-label="Поиск в мессенджерах" onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => e.stopPropagation()}>
    <header><h3>Поиск в мессенджерах</h3><button type="button" aria-label="Закрыть поиск" onClick={onClose}>×</button></header>
    <p className="muted">{phone}</p>
    {error && <p role="alert" className="notice error">{error}</p>}
    {!data && !error && <p role="status">Проверяем доступные мессенджеры…</p>}
    {data && !data.results.length && <p>Нет подключённых мессенджеров, доступных вам по группам.</p>}
    {!!data?.existingChats?.length && <section><h4>Продолжить существующий диалог</h4>{data.existingChats.map(c => <button type="button" key={c.chatId} onClick={() => { onClose(); if (onOpenChat) onOpenChat(c.chatId); else openMessenger(c.chatId); }}>{c.title}</button>)}</section>}
    {!!data?.results.length && <h4>Написать через подключённый номер</h4>}
    {data?.results.map(r => <div className="messenger-search-result" key={r.messenger.id}>
      <div><b>{r.messenger.title || (r.messenger.kind === 'telegram' ? 'Telegram' : 'WhatsApp')} · +{r.messenger.phone}</b><p>{r.status === 'found' ? 'Клиент найден' : r.status === 'not_found' ? 'Не найден' : 'Проверка недоступна'}</p>{r.note && <small className="muted">{r.note}</small>}</div>
      {r.status === 'found' && r.canSend && <button type="button" className="primary" onClick={() => {
        if (r.openlineChatId) { const id = r.openlineChatId; onClose(); if (onOpenChat) onOpenChat(id); else openMessenger(id); }
        else setWriting(r);
      }}>Написать</button>}
    </div>)}
    {writing && <MessengerChatsDialog messenger={writing.messenger} timezone={timezone} admin={false} initialChatId={writing.chatId ?? `${data?.phone}@c.us`} onClose={() => setWriting(null)} />}
  </dialog>;
}
