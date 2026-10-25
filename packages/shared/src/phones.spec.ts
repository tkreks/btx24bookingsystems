import { describe, expect, it } from 'vitest';
import { clientPhoneVariants, messageChannel, normalizeClientPhone } from './phones.js';
import { normalizeMessengerLogin } from './messengers.js';
it('RU mobiles and landlines normalize regardless provider plus/trunk prefix', () => {
 for (const p of ['+7 (925) 973-47-63','79259734763','8 925 973 47 63','9259734763']) expect(normalizeClientPhone(p)).toBe('79259734763');
 expect(normalizeClientPhone('4993467272')).toBe('74993467272');
 expect(clientPhoneVariants('89259734763')).toEqual(['+79259734763','89259734763','79259734763']);
});
it('international number stays international and invalid input is rejected',()=>{
 expect(normalizeClientPhone('+44 20 7946 0958')).toBe('442079460958');
 expect(normalizeClientPhone('12345')).toBeNull(); expect(normalizeClientPhone(null)).toBeNull();
});
describe('channel grouping',()=>{it('same transport from own and external connectors uses one filter',()=>{
 expect(messageChannel('btx24_whatsapp')).toBe('whatsapp');expect(messageChannel('wazzup_whatsapp')).toBe('whatsapp');
 expect(messageChannel('telegrambot')).toBe('telegram');expect(messageChannel('custom_transport')).toBe('custom_transport');
});});

describe('логин Telegram', () => {
  it('@имя, t.me/имя и имя → имя; не логин — null', () => {
    for (const v of ['@ivan_petrov', 'ivan_petrov', 'https://t.me/ivan_petrov', 't.me/ivan_petrov/']) expect(normalizeMessengerLogin(v)).toBe('ivan_petrov');
    for (const v of ['', '@abc', '1ivan_petrov', '+79991234567', 'иван_петров', 'ivan petrov']) expect(normalizeMessengerLogin(v)).toBeNull();
  });
});
