import { eventsOf, mediaTypeOf, msgIdOf, newMemory, toWire, type TgMessage, type TgUser } from './telegram-wire.js';
import { randomLong } from './telegram.js';

const client: TgUser = { _: 'user', id: '5001', access_hash: '-77', first_name: 'Анна', last_name: 'К', phone: '79991234567' };
const users = new Map<string, TgUser>([
  ['5001', client],
  ['777000', { _: 'user', id: '777000', first_name: 'Telegram' }],
  ['42', { _: 'user', id: '42', first_name: 'Бот', pFlags: { bot: true } }],
]);
const msg = (id: number, user: string, text: string, out = false, extra: Partial<TgMessage> = {}): TgMessage => ({
  _: 'message',
  id,
  peer_id: { _: 'peerUser', user_id: user },
  date: 1_760_000_000,
  message: text,
  pFlags: out ? { out: true } : {},
  ...extra,
});

describe('Telegram → вид для api', () => {
  it('личный чат: ID сообщения и чата, номер и имя собеседника', () => {
    expect(toWire(msg(10, '5001', 'Привет'), users)).toMatchObject({
      id: 'tg_10',
      chatId: '5001@lid',
      fromMe: false,
      name: 'Анна К',
      phone: '79991234567',
      body: 'Привет',
      type: 'chat',
      hasMedia: false,
      ack: null,
    });
    expect(toWire(msg(11, '5001', 'Ответ', true, { reply_to: { reply_to_msg_id: 10 } }), users)).toMatchObject({ fromMe: true, name: null, quotedId: 'tg_10', ack: 1 });
    expect(msgIdOf('tg_10')).toBe(10);
    expect(msgIdOf('true_7999@c.us_ABC')).toBeNull();
  });

  it('служебная учётка (коды входа), боты, каналы и служебные сообщения — не переписка', () => {
    expect(toWire(msg(1, '777000', 'Код входа: 12345'), users)).toBeNull();
    expect(toWire(msg(2, '42', 'бот'), users)).toBeNull();
    expect(toWire({ _: 'message', id: 3, peer_id: { _: 'peerChannel', channel_id: '1' }, message: 'x' }, users)).toBeNull();
    expect(toWire({ _: 'messageService', id: 4, peer_id: { _: 'peerUser', user_id: '5001' } }, users)).toBeNull();
  });

  it('вложения: фото, голосовое, документ с именем', () => {
    expect(mediaTypeOf({ _: 'messageMediaPhoto', photo: { _: 'photo', sizes: [{ size: 100 }, { sizes: [10, 2000] }] } })).toEqual({ type: 'image', info: { mime: 'image/jpeg', name: null, size: 2000 } });
    const voice = { _: 'messageMediaDocument', document: { _: 'document' as const, id: 1, mime_type: 'audio/ogg', size: 5, attributes: [{ _: 'documentAttributeAudio', pFlags: { voice: true as const } }] } };
    expect(mediaTypeOf(voice)?.type).toBe('ptt');
    const doc = { _: 'messageMediaDocument', document: { _: 'document' as const, id: 1, mime_type: 'application/pdf', size: 9, attributes: [{ _: 'documentAttributeFilename', file_name: 'счёт.pdf' }] } };
    expect(mediaTypeOf(doc)).toEqual({ type: 'document', info: { mime: 'application/pdf', name: 'счёт.pdf', size: 9 } });
    expect(mediaTypeOf({ _: 'messageMediaWebPage' })).toBeNull();
  });

  it('изменения: новое, правка с прежним текстом, удаление по известному чату, прочтение своих', () => {
    const mem = newMemory();
    const first = eventsOf('i1', [msg(20, '5001', 'Было'), msg(21, '5001', 'Моё', true)], [], users, mem);
    expect(first.messages.map((m) => m.wire.id)).toEqual(['tg_20', 'tg_21']);
    const next = eventsOf(
      'i1',
      [],
      [
        { _: 'updateEditMessage', message: msg(20, '5001', 'Стало') },
        // Реакция — правка без изменения текста: не событие.
        { _: 'updateEditMessage', message: msg(21, '5001', 'Моё', true) },
        { _: 'updateReadHistoryOutbox', peer: { _: 'peerUser', user_id: '5001' }, max_id: 21 },
        { _: 'updateDeleteMessages', messages: [20, 999] },
      ],
      users,
      mem,
    );
    expect(next.events).toEqual([
      expect.objectContaining({ type: 'edit', id: 'tg_20', chatId: '5001@lid', body: 'Стало', prevBody: 'Было' }),
      { type: 'ack', instanceId: 'i1', id: 'tg_21', ack: 3 },
      expect.objectContaining({ type: 'revoke', id: 'tg_20', chatId: '5001@lid' }),
    ]);
  });

  it('random_id — положительный long строкой', () => {
    const v = randomLong();
    expect(v).toMatch(/^\d{1,19}$/);
    expect(BigInt(v) < 2n ** 63n).toBe(true);
  });
});
