import { useEffect, useState } from 'react';
import { messengerLabel, type MessengerDealTargetsDto, type MessengerKind } from '@btx24/shared';
import { apiGet } from '../api.js';
import { FirstMessageDialog, type SearchResult } from '../messengers/by-kind.js';
import { MessengerKindIcon } from '../messengers/MessengerSearchButton.js';
import { fmtLinePhone } from '../openlines/ChannelFilter.js';

type Target = MessengerDealTargetsDto['targets'][number];
const KINDS: MessengerKind[] = ['whatsapp', 'telegram', 'max'];

/** Мессенджеры, где искали клиента: найден хотя бы в одном номере — «найден». */
export function kindsOf(targets: Target[]): { kind: MessengerKind; found: Target[]; note: string | null }[] {
  return KINDS.filter((k) => targets.some((t) => t.messenger.kind === k)).map((kind) => {
    const own = targets.filter((t) => t.messenger.kind === kind);
    const found = own.filter((t) => t.status === 'found');
    const note = found.length ? null : own.some((t) => t.status === 'not_found') ? 'Клиент не найден' : (own.find((t) => t.note)?.note ?? 'Проверка недоступна');
    return { kind, found, note };
  });
}

/**
 * Чатов с клиентом сделки нет (встройка сделки): сразу ищем клиента в мессенджерах. Найден — выбрать
 * мессенджер, затем номер (если подключено несколько), и написать / открыть чат. «✕ Без мессенджера» —
 * служебный чат сделки (только в приложении). «Привязать чат» — чат из мессенджера к клиенту.
 */
export function DealChatStart({ dealId, hasServiceChat, onOpenChat, onServiceChat, onBind }: {
  dealId: number;
  hasServiceChat: boolean;
  onOpenChat: (chatId: number) => void;
  onServiceChat: () => Promise<void> | void;
  onBind: () => void;
}) {
  const [data, setData] = useState<MessengerDealTargetsDto | null>(null);
  const [error, setError] = useState('');
  const [kind, setKind] = useState<MessengerKind | null>(null);
  const [writing, setWriting] = useState<Target | null>(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    let active = true;
    void apiGet<MessengerDealTargetsDto>(`/messengers/deal-targets/${dealId}`).then(
      (d) => active && setData(d),
      (e) => active && setError(e instanceof Error ? e.message : 'Не удалось проверить мессенджеры'),
    );
    return () => {
      active = false;
    };
  }, [dealId]);

  const go = (t: Target) => (t.openlineChatId ? onOpenChat(t.openlineChatId) : setWriting(t));
  const pick = (k: MessengerKind, found: Target[]) => (found.length === 1 ? go(found[0]) : setKind(k));
  const rows = kindsOf(data?.targets ?? []);
  const numbers = kind ? (rows.find((r) => r.kind === kind)?.found ?? []) : [];
  const service = async () => {
    setCreating(true);
    try {
      await onServiceChat();
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="deal-chat-start">
      {!data && !error && (
        <p className="deal-chat-searching" role="status">
          <span className="spinner" aria-hidden="true" /> Ищем клиента в мессенджерах…
        </p>
      )}
      {error && <p className="notice error" role="alert">{error}</p>}
      {data && !data.contact && <p className="notice error" role="alert">У сделки нет контакта — укажите клиента в сделке, чтобы начать переписку.</p>}
      {data?.contact && (
        <p className="muted">
          Клиент <b>{data.contact.name}</b> — {rows.some((r) => r.found.length) ? 'найден в мессенджерах. Выберите, где начать переписку:' : 'в мессенджерах не найден.'}
        </p>
      )}
      {kind ? (
        <>
          <p className="deal-chat-step">
            <button type="button" className="cl-btn" aria-label="Назад к мессенджерам" onClick={() => setKind(null)}>←</button> {messengerLabel(kind)}: с какого номера писать?
          </p>
          <ul className="new-dialog-checks">
            {numbers.map((t) => (
              <li key={t.messenger.id} className="new-dialog-check found">
                <MessengerKindIcon kind={t.messenger.kind} size={30} />
                <span className="new-dialog-check-name">
                  <b>{t.messenger.title || messengerLabel(t.messenger.kind)}</b>
                  <span className="muted">{fmtLinePhone(t.messenger.phone)}{t.openlineChatId ? ' · есть чат' : ''}</span>
                </span>
                <button type="button" className="primary new-dialog-start" onClick={() => go(t)}>{t.openlineChatId ? 'Открыть чат' : 'Написать'}</button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        !!rows.length && (
          <ul className="new-dialog-checks deal-chat-kinds">
            {rows.map((r) => (
              <li key={r.kind} className={`new-dialog-check ${r.found.length ? 'found' : 'not_found'}`}>
                <MessengerKindIcon kind={r.kind} size={30} />
                <span className="new-dialog-check-name">
                  <b>{messengerLabel(r.kind)}</b>
                  <span className="muted">{r.found.length ? (r.found.length > 1 ? `найден в ${r.found.length} номерах` : fmtLinePhone(r.found[0].messenger.phone)) : r.note}</span>
                </span>
                {r.found.length ? (
                  <button type="button" className="primary new-dialog-start" onClick={() => pick(r.kind, r.found)}>
                    {r.found.length === 1 && r.found[0].openlineChatId ? 'Открыть чат' : 'Выбрать'}
                  </button>
                ) : (
                  <span className="new-dialog-status not_found">{r.note}</span>
                )}
              </li>
            ))}
          </ul>
        )
      )}
      {data?.contact && !rows.length && <p className="muted">Нет подключённых мессенджеров со своей линией, с которых вам можно писать.</p>}
      <div className="deal-chat-start-actions">
        <button type="button" onClick={onBind} title="Привязать к клиенту сделки чат из мессенджера">Привязать чат</button>
        {!hasServiceChat && (
          <button type="button" className="deal-chat-no-messenger" disabled={creating} onClick={() => void service()} title="Служебный чат сделки: только в приложении, сюда придут ссылки на оплату и подтверждения">
            ✕ {creating ? 'Создаём…' : 'Без мессенджера'}
          </button>
        )}
      </div>
      {writing?.to && (
        <FirstMessageDialog
          result={{ messenger: writing.messenger, status: 'found', chatId: writing.to, canSend: true, note: null, openlineChatId: null } satisfies SearchResult}
          to={writing.to}
          forDeal={dealId}
          onSent={(id) => {
            setWriting(null);
            onOpenChat(id);
          }}
          onClose={() => setWriting(null)}
        />
      )}
    </div>
  );
}
