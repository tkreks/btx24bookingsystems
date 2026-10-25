import { useCallback, useEffect, useRef, useState } from 'react';
import { messengerLabel, normalizeMessengerLogin, normalizeMessengerPhone, type MessengerContactSearchDto, type MessengerDto, type MessengerKind } from '@btx24/shared';
import { apiGet } from '../api.js';
import { openMessenger } from '../b24.js';
import { fmtLinePhone } from '../openlines/ChannelFilter.js';
import { groupByKind, KIND_STATE_LABEL, StartChatFlow, type SearchResult } from './by-kind.js';
import { MessengerKindIcon } from './MessengerSearchButton.js';

/** Номер (`+7…`) или логин Telegram (`@имя`, `t.me/имя`) → параметр поиска; иначе null. */
export function searchParam(input: string): string | null {
  const phone = normalizeMessengerPhone(input);
  if (phone) return `phone=${encodeURIComponent(phone)}`;
  const login = normalizeMessengerLogin(input);
  return login ? `login=${encodeURIComponent(login)}` : null;
}

/** Подключение подходит для поиска: по логину — только Telegram; `connectedOnly` — своя линия и работает. */
export function eligible(m: MessengerDto, byLogin: boolean, connectedOnly: boolean): boolean {
  if (byLogin && m.kind !== 'telegram') return false;
  return !connectedOnly || (m.line?.mode === 'own' && m.state === 'ready');
}

/**
 * Новый диалог с клиентом: поиск по номеру или логину Telegram во всех подключениях сотрудника —
 * строка на мессенджер (не на аккаунт), у каждой статус проверки; найден — «Начать чат» (несколько
 * аккаунтов — выбор аккаунта). Проверка ничего клиенту не отправляет; сообщение уходит только кнопкой
 * менеджера. `initial` — сразу проверить (без формы); `kinds` — только эти мессенджеры.
 */
export function NewDialogDialog({
  initial,
  connectedOnly = false,
  timezone,
  title = 'Новый диалог',
  kinds,
  onClose,
  onOpenChat,
}: {
  initial?: string;
  connectedOnly?: boolean;
  kinds?: MessengerKind[];
  timezone: string;
  title?: string;
  onClose: () => void;
  onOpenChat?: (chatId: number) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState(initial ?? '');
  const [messengers, setMessengers] = useState<MessengerDto[] | null>(null);
  const [asked, setAsked] = useState<{ q: string; byLogin: boolean } | null>(null);
  const [data, setData] = useState<MessengerContactSearchDto | null>(null);
  const [error, setError] = useState('');
  const [writing, setWriting] = useState<SearchResult[] | null>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  useEffect(() => {
    let alive = true;
    apiGet<MessengerDto[]>('/messengers').then(
      (v) => alive && setMessengers(v),
      () => alive && setMessengers([]),
    );
    return () => {
      alive = false;
    };
  }, []);

  const search = useCallback((q: string) => {
    const param = searchParam(q);
    if (!param) return setError('Введите номер с кодом страны (+7…) или логин Telegram (@имя)');
    setError('');
    setData(null);
    setAsked({ q, byLogin: param.startsWith('login=') });
    apiGet<MessengerContactSearchDto>(`/messengers/search?${param}`).then(
      (d) => setData(d),
      (e) => {
        setAsked(null);
        setError(e instanceof Error ? e.message : 'Не удалось проверить мессенджеры');
      },
    );
  }, []);
  const started = useRef(false);
  useEffect(() => {
    if (initial && !started.current) {
      started.current = true;
      search(initial);
    }
  }, [initial, search]);

  const byLogin = asked?.byLogin ?? false;
  const accounts = asked ? (messengers ?? []).filter((m) => eligible(m, byLogin, connectedOnly) && (!kinds || kinds.includes(m.kind))) : [];
  const rows = groupByKind(accounts, data?.results ?? null);
  const found = rows.flatMap((r) => r.found);

  return (
    <dialog
      ref={ref}
      className="new-dialog"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <header className="new-dialog-head">
        <h3>{title}</h3>
        <button type="button" className="new-dialog-close" aria-label="Закрыть" onClick={onClose}>
          ×
        </button>
      </header>
      {!initial && (
        <form
          className="new-dialog-form"
          onSubmit={(e) => {
            e.preventDefault();
            search(query);
          }}
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="+7 900 000-00-00 или @логин"
            aria-label="Номер телефона или логин Telegram"
            autoComplete="off"
            autoFocus
          />
          <button type="submit" className="primary" disabled={!query.trim()}>
            Искать
          </button>
        </form>
      )}
      {!initial && <p className="new-dialog-hint muted">Номер ищем во всех мессенджерах, логин — в Telegram.</p>}
      {initial && asked && <p className="new-dialog-target">{byLogin ? `@${normalizeMessengerLogin(asked.q)}` : fmtLinePhone(normalizeMessengerPhone(asked.q) ?? '')}</p>}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {asked && messengers && !rows.length && (
        <p className="muted">{connectedOnly ? 'Нет работающих подключений приложения, доступных вам по группам.' : byLogin ? 'Нет подключённого Telegram, доступного вам по группам.' : 'Нет подключённых мессенджеров, доступных вам по группам.'}</p>
      )}
      {!!rows.length && (
        <ul className="new-dialog-checks" aria-live="polite">
          {rows.map((row) => (
            <li key={row.kind} className={`new-dialog-check ${row.state}`}>
              <MessengerKindIcon kind={row.kind} size={30} />
              <span className="new-dialog-check-name">
                <b>{messengerLabel(row.kind)}</b>
                <span className="muted">{row.accounts.length > 1 ? `аккаунтов: ${row.accounts.length}` : row.accounts[0].title || fmtLinePhone(row.accounts[0].phone)}</span>
              </span>
              {row.state === 'found' ? (
                <button type="button" className="primary new-dialog-start" onClick={() => setWriting(row.found)}>
                  Начать чат
                </button>
              ) : (
                <span className={`new-dialog-status ${row.state}`}>
                  {row.state === 'checking' && <span className="spinner" aria-hidden="true" />}
                  {row.note ?? KIND_STATE_LABEL[row.state]}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {data && rows.length > 0 && !found.length && <p className="new-dialog-empty muted">Клиент не найден ни в одном мессенджере. Проверьте номер или логин.</p>}
      {!connectedOnly && !!data?.existingChats?.length && (
        <section className="new-dialog-existing">
          <h4>Уже есть диалоги</h4>
          {data.existingChats.map((c) => (
            <button
              type="button"
              key={c.chatId}
              onClick={() => {
                onClose();
                if (onOpenChat) onOpenChat(c.chatId);
                else openMessenger(c.chatId);
              }}
            >
              {c.title}
            </button>
          ))}
        </section>
      )}
      {writing && (
        <StartChatFlow
          found={writing}
          phone={data?.phone ?? null}
          timezone={timezone}
          onOpenChat={onOpenChat}
          onClose={() => {
            setWriting(null);
          }}
        />
      )}
    </dialog>
  );
}
