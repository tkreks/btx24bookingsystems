import { describe, expect, it } from 'vitest';
import { channelProvider, hasDisabledWazzupChannel } from './channel-error.js';

describe('ошибка выключенного канала Wazzup', () => {
  it.each([
    '=== SYSTEM WZ === Ошибка отправки сообщения: канал выключен',
    '123 === SYSTEM WZ === Ошибка отправки сообщения: канал выключен',
    '=== SYSTEM WZ ===[br]Ошибка отправки сообщения: канал выключен',
    '=== system wz ===\nОшибка отправки сообщения: КАНАЛ ВЫКЛЮЧЕН',
  ])('распознаёт уведомление, включая дописанное к исходящему: %s', text => {
    expect(hasDisabledWazzupChannel('wz_telegram', text)).toBe(true);
  });
  it('не приписывает ошибку новым коннекторам, обычному тексту или другой ошибке', () => {
    expect(hasDisabledWazzupChannel('btx24_telegram', '=== SYSTEM WZ === Ошибка отправки сообщения: канал выключен')).toBe(false);
    expect(hasDisabledWazzupChannel('wz_whatsapp', 'канал выключен')).toBe(false);
    expect(hasDisabledWazzupChannel('wz_whatsapp', '=== SYSTEM WZ === Ошибка отправки сообщения: клиент не найден')).toBe(false);
    expect(hasDisabledWazzupChannel('wz_whatsapp', null)).toBe(false);
  });
  it('различает провайдера и собственное подключение того же мессенджера', () => {
    expect(channelProvider('wz_whatsapp')).toBe('Wazzup');
    expect(channelProvider('btx24_whatsapp')).toBe('Приложение');
    expect(channelProvider('fbinstagramdirect')).toBe(null);
  });
});
