import { useState } from 'react';
import type { ChatChannelDto } from '@btx24/shared';
import { fmtDateTime } from '../format.js';
import { Channel } from './Channel.js';
import { connectorLabel } from './format.js';
import { MinimizeButton } from '../Minimize.js';

/** Каналов больше — один кружок с иконками открытых линий; по нажатию — окно со списком чатов. */
const INLINE_MAX = 2;

/**
 * Чаты открытых линий клиента под его именем: до двух — кнопками, больше — кружком со стопкой
 * иконок и окном, где видно каждый чат (канал, когда писал, ждёт ли ответа).
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
          <div className="sheet channels-modal" role="dialog" aria-modal="true" aria-label="Чаты клиента" onClick={(e) => e.stopPropagation()}>
            <header>
              <h3>Чаты клиента · {channels.length}</h3>
              <MinimizeButton label="Каналы клиента" />
              <button aria-label="Закрыть" onClick={() => setOpen(false)}>
                ×
              </button>
            </header>
            <ul className="channels-list">
              {channels.map((c) => (
                <li key={c.chatId}>
                  <button
                    type="button"
                    className={`channels-row${c.chatId === current ? ' current' : ''}`}
                    disabled={c.chatId === current}
                    onClick={() => {
                      setOpen(false);
                      onOpen(c.chatId);
                    }}
                  >
                    <Channel connector={c.connector} />
                    <span className="channels-title" title={c.title}>
                      {c.title || connectorLabel(c.connector)}
                    </span>
                    <span className="channels-side">
                      {c.chatId === current ? <span className="pill">открыт</span> : c.waitingReply ? <span className="pill waiting">ждёт ответа</span> : null}
                      {c.lastMessageAt && <span className="muted">{fmtDateTime(c.lastMessageAt, timezone)}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
