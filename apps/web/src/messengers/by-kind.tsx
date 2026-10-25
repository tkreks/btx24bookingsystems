import { useEffect, useRef, useState } from 'react';
import { messengerLabel, type MessengerContactSearchDto, type MessengerDto, type MessengerKind, type MessengerSendResultDto } from '@btx24/shared';
import { apiPost } from '../api.js';
import { openMessenger } from '../b24.js';
import { fmtLinePhone } from '../openlines/ChannelFilter.js';
import { MessengerChatsDialog } from './MessengerChatsDialog.js';
import { MessengerKindIcon } from './MessengerSearchButton.js';

export type SearchResult = MessengerContactSearchDto['results'][number];
export type KindState = 'checking' | 'found' | 'denied' | 'not_found' | 'unavailable';

export interface KindRow {
  kind: MessengerKind;
  accounts: MessengerDto[];
  /** Аккаунты, где клиент найден и можно писать. */
  found: SearchResult[];
  state: KindState;
  note: string | null;
}

const KIND_ORDER: MessengerKind[] = ['whatsapp', 'telegram', 'max'];

/**
 * Поиск клиента — по мессенджеру, а не по аккаунту (решение владельца 2026-10-25): несколько номеров
 * WhatsApp — один значок WhatsApp. Состояние вида: найден хотя бы в одном аккаунте → «найден»; ещё
 * проверяем → «проверяем»; иначе — лучшее из «нет права», «не найден», «недоступно».
 */
export function groupByKind(accounts: MessengerDto[], results: SearchResult[] | null): KindRow[] {
  const kinds = KIND_ORDER.filter((k) => accounts.some((m) => m.kind === k));
  return kinds.map((kind) => {
    const list = accounts.filter((m) => m.kind === kind);
    const own = results?.filter((r) => list.some((m) => m.id === r.messenger.id)) ?? [];
    const found = own.filter((r) => r.status === 'found' && r.canSend);
    const denied = own.find((r) => r.status === 'found' && !r.canSend);
    const state: KindState = found.length ? 'found' : !results ? 'checking' : denied ? 'denied' : own.some((r) => r.status === 'not_found') ? 'not_found' : 'unavailable';
    const note = state === 'denied' ? (denied?.note ?? 'Нет права писать') : state === 'unavailable' ? (own.find((r) => r.note)?.note ?? null) : null;
    return { kind, accounts: list, found, state, note };
  });
}

export const KIND_STATE_LABEL: Record<KindState, string> = { checking: 'Проверяем…', found: 'Клиент найден', denied: 'Нет права писать', not_found: 'Не найден', unavailable: 'Проверка недоступна' };

/**
 * Начать переписку с найденным клиентом: несколько аккаунтов мессенджера — сначала выбор аккаунта.
 * Есть чат в открытой линии — открываем его; своя линия без чата — первое сообщение создаёт чат в
 * «Чатах» и открывает его; номер без своей линии — окно мессенджера (как раньше).
 */
export function StartChatFlow({ found, phone, timezone, onOpenChat, onClose }: {
  found: SearchResult[];
  phone: string | null;
  timezone: string;
  onOpenChat?: (chatId: number) => void;
  onClose: () => void;
}) {
  const [chosen, setChosen] = useState<SearchResult | null>(found.length === 1 ? found[0] : null);
  const openChat = (id: number) => {
    onClose();
    if (onOpenChat) onOpenChat(id);
    else openMessenger(id);
  };
  const ready = chosen?.openlineChatId ?? null;
  useEffect(() => {
    if (ready) openChat(ready);
    // Открыть один раз при выборе аккаунта с уже существующим чатом.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  if (!chosen) return <AccountPicker results={found} onPick={setChosen} onClose={onClose} />;
  if (ready) return null;
  const target = chosen.chatId ?? (phone ? `${phone}@c.us` : '');
  if (chosen.messenger.line?.mode === 'own') return <FirstMessageDialog result={chosen} to={target} onSent={openChat} onClose={onClose} />;
  return <MessengerChatsDialog messenger={chosen.messenger} timezone={timezone} admin={false} initialChatId={target} onClose={onClose} />;
}

/** Через какой аккаунт мессенджера писать клиенту. */
export function AccountPicker({ results, onPick, onClose }: { results: SearchResult[]; onPick: (r: SearchResult) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => ref.current?.showModal(), []);
  const kind = results[0]?.messenger.kind;
  return (
    <dialog ref={ref} className="new-dialog account-picker" aria-label="Выбор аккаунта" onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => e.stopPropagation()}>
      <header className="new-dialog-head">
        <h3>{kind ? `${messengerLabel(kind)}: через какой аккаунт писать?` : 'Через какой аккаунт писать?'}</h3>
        <button type="button" className="new-dialog-close" aria-label="Закрыть" onClick={onClose}>×</button>
      </header>
      <ul className="new-dialog-checks">
        {results.map((r) => (
          <li key={r.messenger.id} className="new-dialog-check found">
            <MessengerKindIcon kind={r.messenger.kind} size={30} />
            <span className="new-dialog-check-name">
              <b>{r.messenger.title || messengerLabel(r.messenger.kind)}</b>
              <span className="muted">{fmtLinePhone(r.messenger.phone)}{r.openlineChatId ? ' · есть чат' : ''}</span>
            </span>
            <button type="button" className="primary new-dialog-start" onClick={() => onPick(r)}>Выбрать</button>
          </li>
        ))}
      </ul>
    </dialog>
  );
}

/** Первое сообщение клиенту через свою линию: после отправки чат появляется в «Чатах» и открывается. */
export function FirstMessageDialog({ result, to, onSent, onClose }: { result: SearchResult; to: string; onSent: (chatId: number) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => ref.current?.showModal(), []);
  const m = result.messenger;
  const send = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await apiPost<MessengerSendResultDto>(`/messengers/${encodeURIComponent(m.id)}/send`, { to, text });
      if (r.openlineChatId) onSent(r.openlineChatId);
      else {
        setError('Сообщение отправлено, но чат в открытой линии ещё не создан — он появится в «Чатах» через несколько секунд.');
        setBusy(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось отправить');
      setBusy(false);
    }
  };
  return (
    <dialog ref={ref} className="new-dialog first-message" aria-label="Первое сообщение" onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => e.stopPropagation()}>
      <header className="new-dialog-head">
        <h3>Новый чат · {messengerLabel(m.kind)}</h3>
        <button type="button" className="new-dialog-close" aria-label="Закрыть" onClick={onClose}>×</button>
      </header>
      <p className="muted">
        Через {m.title || fmtLinePhone(m.phone)}{m.line?.name ? ` (линия «${m.line.name}»)` : ''}. Чат появится в «Чатах» после первого сообщения.
      </p>
      <form className="first-message-form" onSubmit={(e) => { e.preventDefault(); if (text.trim() && !busy) void send(); }}>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder="Текст первого сообщения клиенту" aria-label="Текст первого сообщения" autoFocus />
        {error && <p className="notice error" role="alert">{error}</p>}
        <footer className="form-actions">
          <button type="button" onClick={onClose}>Отмена</button>
          <button type="submit" className="primary" disabled={!text.trim() || busy}>{busy ? 'Отправляем…' : 'Отправить'}</button>
        </footer>
      </form>
    </dialog>
  );
}
