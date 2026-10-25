import { useEffect, useRef, useState } from 'react';
import { messageChannel, messengerLabel, normalizeMessengerPhone, type ChatChannelDto, type MessengerContactSearchDto, type MessengerDto, type MessengerKind } from '@btx24/shared';
import { apiGet } from '../api.js';
import { groupByKind, StartChatFlow, type SearchResult } from '../messengers/by-kind.js';
import { eligible, NewDialogDialog } from '../messengers/NewDialogDialog.js';
import { Channel } from './Channel.js';
import { ErrorTriangle } from './ChannelErrorTag.js';

const KINDS: MessengerKind[] = ['whatsapp', 'telegram', 'max'];
const asKind = (connector: string): MessengerKind | null => KINDS.find((k) => k === messageChannel(connector)) ?? null;

/**
 * Wazzup сообщил «канал выключен» (решение владельца 2026-10-25), три выхода:
 * - «Перейти в чат» — чат клиента в подключении приложения (один — сразу, несколько — выбор);
 * - «Начать новый чат» — только если клиент найден в том же мессенджере (аккаунтов несколько — выбор);
 * - «Найти клиента» — поиск в мессенджерах, где чата с клиентом ещё нет.
 * Новый чат создаётся в «Чатах» (своя линия), не в окне мессенджера. Проверка ничего не отправляет;
 * сообщение уходит только кнопкой менеджера, старый текст не повторяется.
 */
export function ChannelRecovery({ connector, channels, phones, timezone, onOpen }: {
  connector: string; channels: ChatChannelDto[]; phones: string[]; timezone: string; onOpen?: (id: number) => void;
}) {
  const valid = [...new Set(phones.map(p => normalizeMessengerPhone(p)).filter((p): p is string => !!p))];
  const [phone, setPhone] = useState(valid[0] ?? '');
  const [messengers, setMessengers] = useState<MessengerDto[] | null>(null);
  const [search, setSearch] = useState<{ phone: string; data: MessengerContactSearchDto | null } | null>(null);
  const [picking, setPicking] = useState(false);
  const [starting, setStarting] = useState<SearchResult[] | null>(null);
  const [finding, setFinding] = useState(false);
  const kind = asKind(connector);
  const own = channels.filter(c => c.connector.startsWith('btx24_'));
  const withChat = new Set(own.map(c => asKind(c.connector)).filter((k): k is MessengerKind => !!k));

  useEffect(() => {
    let alive = true;
    apiGet<MessengerDto[]>('/messengers').then(v => alive && setMessengers(v), () => alive && setMessengers([]));
    return () => { alive = false; };
  }, []);
  // Есть ли клиент в том же мессенджере — проверка регистрации номера, клиенту ничего не уходит.
  useEffect(() => {
    if (!phone || !kind) return;
    let alive = true;
    setSearch({ phone, data: null });
    apiGet<MessengerContactSearchDto>(`/messengers/search?phone=${encodeURIComponent(phone)}`).then(d => alive && setSearch({ phone, data: d }), () => alive && setSearch({ phone, data: null }));
    return () => { alive = false; };
  }, [phone, kind]);

  const accounts = (messengers ?? []).filter(m => eligible(m, false, true));
  const same = kind ? groupByKind(accounts.filter(m => m.kind === kind), search?.phone === phone ? (search.data?.results ?? null) : null)[0] : undefined;
  const missingKinds = KINDS.filter(k => accounts.some(m => m.kind === k) && !withChat.has(k));
  const go = () => (own.length === 1 ? onOpen?.(own[0].chatId) : setPicking(true));

  return <section className="channel-recovery" role="alert" aria-label="Ошибка канала Wazzup">
    <div className="channel-recovery-head">
      <ErrorTriangle size={30} />
      <div>
        <b>Канал Wazzup выключен</b>
        <p>Сообщения из этого чата не доходят до клиента. Продолжите переписку через подключение приложения — старый чат останется в истории.</p>
      </div>
    </div>
    <div className="channel-recovery-actions">
      {valid.length > 1 && <select value={phone} onChange={e => setPhone(e.target.value)} aria-label="Номер клиента">
        {valid.map(p => <option key={p} value={p}>+{p}</option>)}
      </select>}
      {onOpen && !!own.length && <button type="button" className="channel-recovery-open" onClick={go} title={own.length === 1 ? `${own[0].title} · Чат #${own[0].chatId}` : `Чатов: ${own.length}`}>
        Перейти в чат {own.length === 1 ? <Channel connector={own[0].connector} /> : <span className="cl-tab-counter">{own.length}</span>}
      </button>}
      {same?.state === 'found' && <button type="button" className="channel-recovery-start" onClick={() => setStarting(same.found)}>
        Начать новый чат{kind ? ` в ${messengerLabel(kind)}` : ''}
      </button>}
      {same?.state === 'checking' && <span className="muted channel-recovery-checking"><span className="spinner" aria-hidden="true" /> Ищем клиента в {kind ? messengerLabel(kind) : 'мессенджере'}…</span>}
      {!!valid.length && !!missingKinds.length && <button type="button" className="channel-recovery-find" onClick={() => setFinding(true)}>Найти клиента</button>}
    </div>
    {picking && <ChatPicker chats={own} onPick={id => { setPicking(false); onOpen?.(id); }} onClose={() => setPicking(false)} />}
    {starting && <StartChatFlow found={starting} phone={phone || null} timezone={timezone} onOpenChat={onOpen} onClose={() => setStarting(null)} />}
    {finding && <NewDialogDialog
      initial={phone}
      connectedOnly
      kinds={missingKinds}
      timezone={timezone}
      title="Найти клиента"
      onClose={() => setFinding(false)}
      onOpenChat={id => { setFinding(false); onOpen?.(id); }}
    />}
  </section>;
}

/** Несколько чатов клиента в подключении приложения — какой открыть. */
function ChatPicker({ chats, onPick, onClose }: { chats: ChatChannelDto[]; onPick: (id: number) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => ref.current?.showModal(), []);
  return <dialog ref={ref} className="new-dialog" aria-label="Выбор чата" onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => e.stopPropagation()}>
    <header className="new-dialog-head"><h3>Какой чат открыть?</h3><button type="button" className="new-dialog-close" aria-label="Закрыть" onClick={onClose}>×</button></header>
    <ul className="new-dialog-checks">
      {chats.map(c => <li key={c.chatId} className="new-dialog-check found">
        <Channel connector={c.connector} />
        <span className="new-dialog-check-name"><b>{c.title}</b><span className="muted">Чат #{c.chatId}</span></span>
        <button type="button" className="primary new-dialog-start" onClick={() => onPick(c.chatId)}>Открыть</button>
      </li>)}
    </ul>
  </dialog>;
}
