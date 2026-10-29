import { useEffect, useRef, useState } from 'react';
import { messageChannel, messengerLabel, type MessengerChatTargetsDto, type MessengerDealTargetsDto } from '@btx24/shared';
import { apiGet } from '../api.js';
import { fmtLinePhone } from '../openlines/ChannelFilter.js';
import { FirstMessageDialog, type SearchResult } from './by-kind.js';
import { MessengerKindIcon } from './MessengerSearchButton.js';

type Target = MessengerDealTargetsDto['targets'][number];

const VIA: Record<NonNullable<Target['via']>, string> = {
  chat: 'есть переписка',
  telegram: 'по ID Telegram из карточки клиента',
  login: 'по логину Telegram',
  phone: 'по номеру клиента',
};

/**
 * Новый чат с клиентом сделки вместо чата в неработающей линии (встройка сделки). Клиент — контакт
 * сделки: сервер связывает с ним диалог до первого сообщения, поэтому линия не создаст нового клиента,
 * даже если мессенджер не показывает номер. Сначала — мессенджер прежнего чата (`kind`).
 * `chatId` — «Присоединиться к чату» в неработающем чате: только наш номер, сопоставленный с линией
 * этого чата (линия ↔ один аккаунт мессенджера); клиент найден в одном номере — сразу к сообщению.
 */
export function DealNewChatDialog({ dealId, chatId, kind, onOpenChat, onClose }: { dealId: number; chatId?: number; kind: string | null; onOpenChat: (chatId: number) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<MessengerDealTargetsDto | MessengerChatTargetsDto | null>(null);
  const [error, setError] = useState('');
  const [writing, setWriting] = useState<Target | null>(null);
  useEffect(() => ref.current?.showModal(), []);
  useEffect(() => {
    let active = true;
    void apiGet<MessengerDealTargetsDto | MessengerChatTargetsDto>(chatId ? `/messengers/chat-targets/${chatId}` : `/messengers/deal-targets/${dealId}`).then(
      (d) => {
        if (!active) return;
        setData(d);
        // Продолжение неработающего чата: клиент найден ровно в одном нашем номере — без лишнего шага.
        const found = d.targets.filter((t) => t.status === 'found');
        if (chatId && found.length === 1 && d.targets.length === 1) {
          if (found[0].openlineChatId) {
            onClose();
            onOpenChat(found[0].openlineChatId);
          } else setWriting(found[0]);
        }
      },
      (e) => active && setError(e instanceof Error ? e.message : 'Не удалось проверить мессенджеры'),
    );
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealId, chatId]);

  const open = (chatId: number) => {
    onClose();
    onOpenChat(chatId);
  };
  if (writing?.to) {
    const result: SearchResult = { messenger: writing.messenger, status: 'found', chatId: writing.to, canSend: true, note: null, openlineChatId: null };
    return <FirstMessageDialog result={result} to={writing.to} forDeal={dealId} onSent={open} onClose={() => setWriting(null)} />;
  }
  const sameKind = (t: Target) => (kind && messageChannel(t.messenger.kind) === kind ? 0 : 1);
  const targets = [...(data?.targets ?? [])].sort((a, b) => sameKind(a) - sameKind(b));
  return (
    <dialog ref={ref} className="new-dialog deal-new-chat" aria-label="Новый чат с клиентом" onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => e.stopPropagation()}>
      <header className="new-dialog-head">
        <h3>{chatId ? 'Продолжить переписку через наш номер' : 'Новый чат с клиентом'}</h3>
        <button type="button" className="new-dialog-close" aria-label="Закрыть" onClick={onClose}>×</button>
      </header>
      {!data && !error && <p className="muted">Ищем клиента в мессенджерах…</p>}
      {error && <p className="notice error" role="alert">{error}</p>}
      {data && !data.contact && <p className="notice error" role="alert">У сделки нет контакта — укажите клиента в сделке, чтобы создать чат.</p>}
      {data?.contact && (
        <p className="muted">
          Клиент: <b>{data.contact.name}</b>. Новый чат привяжется к этому клиенту — нового контакта и сделки не будет.
        </p>
      )}
      {data && 'channel' in data && data.channel && (
        <p className="muted">Канал этого чата закреплён за номером {fmtLinePhone(data.channel.split(':')[1] ?? '')} — новый чат начнётся с него.</p>
      )}
      {data?.contact && !targets.length && (
        <p className="muted">
          {data && 'channel' in data && data.channel
            ? 'Номер этого канала не подключён к своей линии приложения или вам нельзя с него писать.'
            : 'Нет подключённых мессенджеров со своей линией, с которых вам можно писать.'}
        </p>
      )}
      {!!targets.length && (
        <ul className="new-dialog-checks">
          {targets.map((t) => (
            <li key={t.messenger.id} className={`new-dialog-check ${t.status}`}>
              <MessengerKindIcon kind={t.messenger.kind} size={30} />
              <span className="new-dialog-check-name">
                <b>{t.messenger.title || messengerLabel(t.messenger.kind)}</b>
                <span className="muted">
                  {fmtLinePhone(t.messenger.phone)}
                  {t.via ? ` · ${VIA[t.via]}` : ''}
                </span>
                {t.note && <span className="muted">{t.note}</span>}
              </span>
              {t.status === 'found' && t.openlineChatId ? (
                <button type="button" className="primary new-dialog-start" onClick={() => open(t.openlineChatId!)}>Открыть чат</button>
              ) : t.status === 'found' ? (
                <button type="button" className="primary new-dialog-start" onClick={() => setWriting(t)}>Написать</button>
              ) : (
                <span className={`new-dialog-status ${t.status}`}>{t.status === 'not_found' ? 'Клиент не найден' : (t.note ?? 'Проверка недоступна')}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </dialog>
  );
}
