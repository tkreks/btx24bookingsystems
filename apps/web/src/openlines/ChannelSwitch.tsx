import { useState } from 'react';
import type { ChatChannelDto } from '@btx24/shared';
import type { AttentionChatDto } from '@btx24/shared';
import { openCrm } from '../b24.js';
import { AttentionMessage } from '../dashboard/AttentionMessage.js';
import { Channel } from './Channel.js';
import { Icon } from './icons.js';
import { MinimizeButton } from '../Minimize.js';

/** Каналов больше — один кружок с иконками открытых линий; по нажатию — окно со списком чатов. */
const INLINE_MAX = 2;

/** Чат клиента — строкой как в «Последних сообщениях» дашборда. */
export function asAttention(c: ChatChannelDto): AttentionChatDto {
  return {
    chatId: c.chatId,
    unread: c.unread ?? 0,
    title: c.title,
    clientName: c.clientName ?? null,
    clientAvatar: c.clientAvatar ?? null,
    connector: c.connector,
    lastMessageAt: c.lastMessageAt ?? '',
    preview: c.preview ?? '',
    hasFiles: c.hasFiles ?? false,
    dealId: c.dealId ?? null,
    contactId: null,
    responsibleId: null,
  };
}

/**
 * Чаты открытых линий клиента под его именем: до двух — кнопками, больше — кружком со стопкой
 * иконок и окном: строки как «Последние сообщения» дашборда, у каждой — «Сделка» и «Перейти в чат».
 */
export function ChannelSwitch({
  channels,
  current,
  connector,
  timezone,
  onOpen,
}: {
  channels: ChatChannelDto[];
  current: number;
  connector: string;
  timezone: string;
  onOpen?: (chatId: number) => void;
}) {
  const [open, setOpen] = useState(false);
  if (channels.length < 2 || !onOpen) return <Channel connector={connector} />;
  if (channels.length <= INLINE_MAX)
    return (
      <span className="cv-channels" role="group" aria-label="Мессенджер клиента">
        {channels.map((c) => (
          <button
            key={c.chatId}
            type="button"
            className={`cv-channel${c.chatId === current ? ' active' : ''}`}
            aria-pressed={c.chatId === current}
            title={c.waitingReply ? 'Ждёт ответа' : undefined}
            onClick={() => c.chatId !== current && onOpen(c.chatId)}
          >
            <Channel connector={c.connector} />
            {c.waitingReply && <i className="cv-channel-dot" aria-label="ждёт ответа" />}
          </button>
        ))}
      </span>
    );
  const waiting = channels.filter((c) => c.waitingReply && c.chatId !== current).length;
  return (
    <>
      <Channel connector={connector} />
      <button
        type="button"
        className="cv-channel-stack"
        aria-haspopup="dialog"
        aria-label={`Другие чаты клиента: ${channels.length - 1}${waiting ? `, ждут ответа: ${waiting}` : ''}`}
        title="Другие чаты клиента"
        onClick={() => setOpen(true)}
      >
        {channels
          .filter((c) => c.chatId !== current)
          .slice(0, 3)
          .map((c) => (
            <span key={c.chatId} className="cv-stack-dot">
              <Channel connector={c.connector} />
            </span>
          ))}
        <b>+{channels.length - 1}</b>
        {waiting > 0 && <i className="cv-channel-dot" aria-hidden="true" />}
      </button>
      {open && (
        <div className="sheet-backdrop" onClick={() => setOpen(false)}>
          <div className="sheet channels-modal dash-attention" role="dialog" aria-modal="true" aria-label="Чаты клиента" onClick={(e) => e.stopPropagation()}>
            <header>
              <h3>Чаты клиента · {channels.length}</h3>
              <MinimizeButton label="Каналы клиента" />
              <button aria-label="Закрыть" onClick={() => setOpen(false)}>
                ×
              </button>
            </header>
            <ul className="attention-rows">
              {channels.map((c) => {
                const go = () => {
                  setOpen(false);
                  if (c.chatId !== current) onOpen(c.chatId);
                };
                return (
                  <li key={c.chatId} className={c.chatId === current ? 'current' : undefined}>
                    <AttentionMessage chat={asAttention(c)} timezone={timezone} onOpen={go} />
                    <span className="attention-actions">
                      <button
                        className="dash-icon-btn"
                        title={c.dealId ? `Сделка #${c.dealId}` : 'Чат не привязан к сделке'}
                        aria-label="Открыть сделку"
                        disabled={!c.dealId}
                        onClick={() => c.dealId && openCrm('deal', c.dealId)}
                      >
                        <Icon name="deal" size={18} />
                      </button>
                      <button className="dash-icon-btn" title={c.chatId === current ? 'Этот чат уже открыт' : 'Перейти в чат'} aria-label="Перейти в чат" disabled={c.chatId === current} onClick={go}>
                        <Icon name="gochat" size={18} />
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
