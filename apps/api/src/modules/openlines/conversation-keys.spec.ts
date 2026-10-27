import { describe, expect, it } from 'vitest';
import { autoChannel, conversationKey, entityParts } from './conversation-keys.js';

const own = [
  { kind: 'whatsapp', phone: '74993467272', lineId: 14 },
  { kind: 'whatsapp', phone: '74993257916', lineId: 18 },
  { kind: 'telegram', phone: '79895793606', lineId: 16 },
];
const crm = (contactId: number | null) => ({ leadId: null, contactId, companyId: null, dealId: 1 });

describe('conversation keys', () => {
  it('parses entity_id and strips deal context', () => {
    expect(entityParts('btx24_telegram|16|5789248202@lid::deal:40184|17090')).toEqual({ lineId: 16, extChatId: '5789248202@lid' });
    expect(entityParts('wz_whatsapp_ceacd473beec8c39f54fd7afd810cd43d|4|ec0c-uuid|288')).toEqual({ lineId: 4, extChatId: 'ec0c-uuid' });
    expect(entityParts(null)).toEqual({ lineId: null, extChatId: null });
  });

  it('maps lines to our numbers: own line, digits in the line name, otherwise the line itself', () => {
    expect(autoChannel({ id: 14, name: 'WhatsApp +74993467272' }, own)).toBe('whatsapp:74993467272');
    expect(autoChannel({ id: 4, name: 'WAZZUP - БК Алатырь (7272)', connectors: ['wz_whatsapp'] }, own)).toBe('whatsapp:74993467272');
    expect(autoChannel({ id: 2, name: 'WAZZUP - БК Алатырь' }, own)).toBe('line:2');
    // Цифры подходят к двум номерам разных видов, вид линии неизвестен — не угадываем.
    expect(autoChannel({ id: 9, name: 'Линия 3606 7272' }, own)).toBe('line:9');
  });

  it('merges Wazzup and our connector on one number and deal chats into one conversation', () => {
    const channels = new Map([[4, 'whatsapp:74993467272'], [14, 'whatsapp:74993467272'], [16, 'telegram:79895793606'], [2, 'line:2']]);
    const key = (chatId: number, lineId: number, ext: string, contactId: number | null = 140) =>
      conversationKey({ chatId, crm: crm(contactId), connector: 'x', lineId, extChatId: ext }, channels);
    expect(key(4394, 4, 'a')).toBe(key(50848, 14, 'b'));
    expect(key(4394, 4, 'a')).not.toBe(key(4396, 2, 'a'));
    expect(key(50856, 16, '5789248202@lid')).toBe(key(51054, 16, '5789248202@lid'));
    // Без контакта — по собеседнику линии; группа — отдельно от контакта.
    expect(key(1, 16, 'u@lid', null)).toBe('telegram:79895793606|x:u@lid');
    expect(key(2, 16, '123@g.us')).toBe('telegram:79895793606|x:123@g.us');
  });
});
