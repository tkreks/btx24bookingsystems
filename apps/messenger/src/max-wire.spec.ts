import { describe, expect, it } from 'vitest';
import { decodeFrame, dialogIdOf, encodeFrame, eventsOf, lz4Block, newMemory, OP, parseWireId, toWire, wireIdOf, type MaxContact } from './max-wire.js';

// Настоящие кадры web.max.ru (вход по QR без входа; ссылка давно истекла): ответ сервера — сжат LZ4
// (байт сжатия 2) с длинными числами расширением msgpack 1; запрос страницы — сжат (байт 1).
const QR_ANSWER =
  'CgEAAQEgAgAAjP8+had0cmFja0lk2SRkOWE1NmE4ZC05YWQ0LTRiYTktODljMy1lNTFlY2U1NmU1M2SmcXJMaW5r2TlodHRwczovL21heC5ydS86YXV0aC9CABHwKalleHBpcmVzQXTHCQHTAAABoW/mU0mvcG9sbGluZ0ludGVydmFsxwMB0ROIo3R0bMcFAdIAAdS3';
const QR_POLL = 'CgAAAgEhAQAAMfAggad0cmFja0lk2SRkOWE1NmE4ZC05YWQ0LTRiYTktODljMy1lNTFlY2U1NmU1M2Q=';

const ME = '1000';
const CLIENT = '2000';
const CHAT = String(BigInt(ME) ^ BigInt(CLIENT));
const contacts = new Map<string, MaxContact>([[CLIENT, { id: 2000, phone: 79991234567, names: [{ firstName: 'Ольга', lastName: 'И.', type: 'ONEME' }] }]]);

describe('кадры MAX', () => {
  it('разбирает настоящий сжатый ответ сервера', () => {
    const f = decodeFrame(Buffer.from(QR_ANSWER, 'base64'));
    expect(f).toMatchObject({ cmd: 1, seq: 1, opcode: 288 });
    const p = f.payload as Record<string, unknown>;
    expect(p.trackId).toBe('d9a56a8d-9ad4-4ba9-89c3-e51ece56e53d');
    expect(String(p.qrLink)).toMatch(/^https:\/\/max\.ru\/:auth\//);
    expect(p.pollingInterval).toBe(5000);
    expect(typeof p.expiresAt).toBe('number');
  });

  it('разбирает сжатый запрос страницы', () => {
    expect(decodeFrame(Buffer.from(QR_POLL, 'base64'))).toEqual({ cmd: 0, seq: 2, opcode: 289, payload: { trackId: 'd9a56a8d-9ad4-4ba9-89c3-e51ece56e53d' } });
  });

  it('кодирует свою команду с отрицательным seq и длинными ID без потерь', () => {
    const big = 2n ** 62n + 5n;
    const f = decodeFrame(encodeFrame({ cmd: 0, seq: -7, opcode: OP.send, payload: { chatId: big, message: { text: 'Привет', attaches: undefined }, notify: true } }));
    expect(f).toMatchObject({ cmd: 0, seq: -7, opcode: 64 });
    expect(f.payload).toEqual({ chatId: big, message: { text: 'Привет' }, notify: true });
  });

  it('LZ4: литералы и пересекающееся копирование; битый блок — ошибка', () => {
    // «ab» + повтор с отступом 2 длиной 6 → «abababab», затем литерал «!».
    const block = Uint8Array.from([0x22, 0x61, 0x62, 0x02, 0x00, 0x10, 0x21]);
    expect(Buffer.from(lz4Block(block, 64)).toString()).toBe('abababab!');
    expect(() => lz4Block(Uint8Array.from([0x10, 0x61, 0x05, 0x00]), 64)).toThrow(/LZ4/);
  });
});

describe('сообщения MAX', () => {
  it('ID сообщения несёт чат: правка и удаление без памяти сервиса', () => {
    const id = wireIdOf(CHAT, 2n ** 60n);
    expect(parseWireId(id)).toEqual({ chatId: BigInt(CHAT), messageId: 2n ** 60n });
    expect(parseWireId('tg_5')).toBeNull();
    expect(dialogIdOf(ME, CLIENT)).toBe(BigInt(CHAT));
  });

  it('входящее → собеседник @lid с номером и именем; ответ на сообщение', () => {
    const w = toWire(CHAT, { id: 55, time: 1_700_000_000_123, sender: 2000, text: 'Есть баня на субботу?', link: { type: 'REPLY', message: { id: 54 } } }, ME, contacts);
    expect(w).toMatchObject({ id: `max_${CHAT}_55`, chatId: `${CLIENT}@lid`, fromMe: false, name: 'Ольга И.', phone: '79991234567', type: 'chat', quotedId: `max_${CHAT}_54`, timestamp: 1_700_000_000 });
  });

  it('файл и фото — вложения; боты, группы и «Избранное» не попадают', () => {
    expect(toWire(CHAT, { id: 1, time: 1, sender: 1000, attaches: [{ _type: 'FILE', fileId: 9, name: 'счёт.pdf', size: 1200 }] }, ME, contacts)).toMatchObject({ fromMe: true, type: 'document', hasMedia: true, mediaInfo: { name: 'счёт.pdf', size: 1200 } });
    expect(toWire(CHAT, { id: 2, time: 1, sender: 2000, attaches: [{ _type: 'PHOTO', baseUrl: 'https://x' }] }, ME, contacts)?.type).toBe('image');
    const bots = new Map<string, MaxContact>([[CLIENT, { id: 2000, flags: 2 }]]);
    expect(toWire(CHAT, { id: 3, time: 1, sender: 2000, text: 'x' }, ME, bots)).toBeNull();
    expect(toWire('-77', { id: 4, time: 1, sender: 2000, text: 'x' }, ME, contacts)).toBeNull();
    expect(toWire('0', { id: 5, time: 1, sender: 1000, text: 'x' }, ME, contacts)).toBeNull();
  });

  it('события: новое, правка (было → стало), удаление, «прочитано» собеседником', () => {
    const mem = newMemory();
    const out = eventsOf('i1', OP.notifMessage, { chatId: BigInt(CHAT), message: { id: 7, time: 5000, sender: 1000, text: 'Ждём вас' } }, ME, contacts, mem);
    expect(out.message?.wire).toMatchObject({ id: `max_${CHAT}_7`, fromMe: true });
    const edit = eventsOf('i1', OP.notifMessage, { chatId: CHAT, message: { id: 7, time: 5000, sender: 1000, text: 'Ждём вас в 18:00', status: 'EDITED' } }, ME, contacts, mem);
    expect(edit.message).toBeNull();
    expect(edit.events).toMatchObject([{ type: 'edit', id: `max_${CHAT}_7`, body: 'Ждём вас в 18:00', prevBody: 'Ждём вас' }]);
    expect(eventsOf('i1', OP.notifMark, { chatId: CHAT, userId: 2000, mark: 4000 }, ME, contacts, mem).events).toEqual([]);
    expect(eventsOf('i1', OP.notifMark, { chatId: CHAT, userId: 2000, mark: 6000 }, ME, contacts, mem).events).toEqual([{ type: 'ack', instanceId: 'i1', id: `max_${CHAT}_7`, ack: 3 }]);
    const del = eventsOf('i1', OP.notifDelete, { chat: { id: CHAT, type: 'DIALOG' }, messageIds: [7, 8] }, ME, contacts, mem);
    expect(del.events.map((e) => (e.type === 'revoke' ? e.id : ''))).toEqual([`max_${CHAT}_7`, `max_${CHAT}_8`]);
    expect(eventsOf('i1', OP.notifMessage, { chatId: '-5', chat: { id: '-5', type: 'CHAT' }, message: { id: 1, time: 1, sender: 2000 } }, ME, contacts, mem).message).toBeNull();
  });
});
