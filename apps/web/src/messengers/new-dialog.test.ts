import { describe, expect, it } from 'vitest';
import type { MessengerDto } from '@btx24/shared';
import { eligible, searchParam } from './NewDialogDialog.js';

const m = (kind: MessengerDto['kind'], state: MessengerDto['state'] = 'ready', own = true) => ({ kind, state, line: own ? { mode: 'own' } : null }) as MessengerDto;

describe('Новый диалог', () => {
  it('номер → phone, логин Telegram → login, прочее — не ищем', () => {
    expect(searchParam('+7 (915) 093-54-22')).toBe('phone=79150935422');
    expect(searchParam('@ivan_petrov')).toBe('login=ivan_petrov');
    expect(searchParam('t.me/ivan_petrov')).toBe('login=ivan_petrov');
    expect(searchParam('Иван')).toBeNull();
  });

  it('по логину — только Telegram; после ошибки Wazzup — только работающие свои линии', () => {
    expect(eligible(m('whatsapp'), true, false)).toBe(false);
    expect(eligible(m('telegram'), true, false)).toBe(true);
    expect(eligible(m('whatsapp', 'qr'), false, true)).toBe(false);
    expect(eligible(m('whatsapp', 'ready', false), false, true)).toBe(false);
    expect(eligible(m('max', 'qr'), false, false)).toBe(true);
  });
});
