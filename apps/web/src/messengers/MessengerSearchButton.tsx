import { useEffect, useState } from 'react';
import type { MessengerContactSearchDto, MessengerDto, MessengerKind } from '@btx24/shared';
import { groupByKind, StartChatFlow, type SearchResult } from './by-kind.js';
import { apiGet } from '../api.js';
import { Icon } from '../openlines/icons.js';
import { MessengerSearchDialog } from './MessengerSearchDialog.js';
const KIND_LABEL: Record<MessengerKind, string> = { whatsapp: 'WhatsApp', telegram: 'Telegram', max: 'MAX' };

/** Значок мессенджера (круг в цвете бренда). */
export function MessengerKindIcon({ kind, size = 22 }: { kind: MessengerKind; size?: number }) {
  return (
    <svg className={`messenger-kind-glyph ${kind}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="12" />
      {kind === 'whatsapp' && (
        <path d="M8.6 6.8c.3-.3.8-.3 1 .1l1.1 2c.2.3.1.7-.1 1l-.6.6c.5 1.2 1.5 2.3 2.8 2.9l.6-.6c.3-.3.7-.3 1-.1l2 1.1c.4.2.4.7.1 1l-1 1c-.6.6-1.6.7-2.4.3-2.4-1.1-4.3-3-5.4-5.4-.4-.8-.3-1.8.3-2.4Z" />
      )}
      {kind === 'telegram' && <path d="M5.5 11.6 17.4 7c.6-.2 1.1.1.9.9l-2 9.5c-.1.6-.6.8-1.1.5l-3-2.2-1.5 1.4c-.2.2-.3.2-.5.2l.2-3.1 5.6-5.1c.3-.2-.1-.4-.4-.2L8.7 13l-3-.9c-.6-.2-.6-.6-.2-.5Z" />}
      {kind === 'max' && <path d="M7 16.5v-9h1.8L12 12l3.2-4.5H17v9h-2v-5.6l-3 4.1-3-4.1v5.6Z" />}
    </svg>
  );
}

/** Состояние значка: ищем — бегущие точки; найден — «1», как непрочитанное; не найден — красный крестик. */
function Badge({ state }: { state: 'searching' | 'found' | 'missing' }) {
  if (state === 'searching')
    return (
      <span className="msr-badge searching" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    );
  if (state === 'found')
    return (
      <span className="msr-badge found" aria-hidden="true">
        1
      </span>
    );
  return (
    <span className="msr-badge missing" aria-hidden="true">
      <svg width="8" height="8" viewBox="0 0 8 8">
        <path d="M1 1l6 6M7 1 1 7" />
      </svg>
    </span>
  );
}

/**
 * Поиск клиента по номеру в подключённых мессенджерах (карточка звонка, блок «Звонки»). До нажатия —
 * значок поиска; после — один значок на мессенджер (не на аккаунт) со статусом. Найден — нажатие
 * открывает переписку (несколько аккаунтов — сначала выбор аккаунта); иначе — подробности поиска.
 */
export function MessengerSearchButton({ phone, timezone, onOpenChat, withLabel = false, autoStart = false }: { phone: string; timezone: string; onOpenChat?: (chatId: number) => void; withLabel?: boolean; /** Искать сразу, без нажатия (встройка сделки при ошибке канала). */ autoStart?: boolean }) {
  const [list, setList] = useState<MessengerDto[] | null>(null);
  const [data, setData] = useState<MessengerContactSearchDto | null>(null);
  const [error, setError] = useState('');
  const [started, setStarted] = useState(autoStart);
  const [details, setDetails] = useState(false);
  const [writing, setWriting] = useState<SearchResult[] | null>(null);

  const load = () => {
    // Список номеров приходит быстро — значки видны сразу, пока идёт проверка в мессенджерах.
    apiGet<MessengerDto[]>('/messengers').then(setList, () => setList([]));
    apiGet<MessengerContactSearchDto>(`/messengers/search?phone=${encodeURIComponent(phone)}`).then(setData, (e) =>
      setError(e instanceof Error ? e.message : 'Не удалось проверить мессенджеры'),
    );
  };
  const start = () => {
    setStarted(true);
    setError('');
    setData(null);
    load();
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- поиск один раз при показе
  useEffect(() => { if (autoStart) load(); }, [autoStart, phone]);

  if (!started)
    return (
      <button type="button" className={withLabel ? 'msr-start' : 'dash-icon-btn'} aria-label="Поиск в мессенджерах" title="Найти клиента в доступных мессенджерах" onClick={start}>
        <Icon name="search" size={18} />
        {withLabel && ' Мессенджеры'}
      </button>
    );

  const messengers = data?.results.map((r) => r.messenger) ?? list ?? [];
  const kinds = groupByKind(messengers, data?.results ?? (error ? [] : null));
  const existing = data?.existingChats ?? [];
  return (
    <span className="msr" role="group" aria-label="Поиск в мессенджерах" aria-busy={!data && !error}>
      {!messengers.length && !data && !error && (
        <span className="msr-icon" title="Ищем…">
          <Icon name="search" size={18} />
          <Badge state="searching" />
        </span>
      )}
      {kinds.map((k) => {
        const state = k.state === 'checking' ? 'searching' : k.state === 'found' ? 'found' : 'missing';
        const name = KIND_LABEL[k.kind] + (k.accounts.length > 1 ? ` (аккаунтов: ${k.accounts.length})` : '');
        const text = error ? `${name}: ${error}` : k.state === 'checking' ? `${name}: ищем…` : k.state === 'found' ? `${name}: клиент найден — открыть переписку` : k.state === 'not_found' ? `${name}: не найден` : `${name}: ${k.note ?? 'проверка недоступна'}`;
        return (
          <button key={k.kind} type="button" className={`msr-icon ${state}`} disabled={k.state === 'checking' && !error} title={text} aria-label={text} onClick={() => (k.state === 'found' ? setWriting(k.found) : setDetails(true))}>
            <MessengerKindIcon kind={k.kind} />
            <Badge state={state} />
          </button>
        );
      })}
      {data && !messengers.length && <span className="muted msr-none">нет мессенджеров</span>}
      {!!existing.length && (
        <button type="button" className="msr-icon found" title={`Есть диалоги в открытых линиях: ${existing.map((c) => c.title).join(', ')}`} aria-label="Существующие диалоги" onClick={() => setDetails(true)}>
          <Icon name="chat" size={20} />
          <span className="msr-badge found" aria-hidden="true">{existing.length}</span>
        </button>
      )}
      {(data || error) && (
        <button type="button" className="msr-again" title="Искать заново" aria-label="Искать заново" onClick={start}>
          <Icon name="refresh" size={14} />
        </button>
      )}
      {details && <MessengerSearchDialog phone={phone} timezone={timezone} initial={data} onClose={() => setDetails(false)} onOpenChat={onOpenChat} />}
      {writing && <StartChatFlow found={writing} phone={data?.phone ?? null} timezone={timezone} onOpenChat={onOpenChat} onClose={() => setWriting(null)} />}
    </span>
  );
}
