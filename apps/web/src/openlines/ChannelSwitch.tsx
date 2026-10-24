import type { ChatChannelDto } from '@btx24/shared';
import { Channel } from './Channel.js';
import { connectorLabel } from './format.js';

/** Выбор доступного диалога клиента по каналу сообщений. */
export function ChannelSwitch({
  channels,
  current,
  connector,
  onOpen,
}: {
  channels: ChatChannelDto[];
  current: number;
  connector: string;
  timezone: string;
  onOpen?: (chatId: number) => void;
}) {
  if (channels.length < 2 || !onOpen) return <Channel connector={connector} />;
  return <label className="cv-channel-select">Канал сообщений <select aria-label="Канал клиента" value={current} onChange={e=>onOpen(Number(e.target.value))}>
    {channels.map(c=><option key={c.chatId} value={c.chatId}>{connectorLabel(c.connector)} · {c.title || `Чат #${c.chatId}`}{c.waitingReply ? ' · ждёт ответа' : ''}</option>)}
  </select></label>;
}
