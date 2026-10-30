import { ForbiddenException } from '@nestjs/common';
import { MessengerHookController, sameMessengerToken } from './messengers.controller.js';

const TOKEN = 'a'.repeat(48);
const make = (token: string) => {
  const applied: unknown[] = [];
  const ctrl = new MessengerHookController({ apply: async (e: unknown[]) => void applied.push(...e) } as never, { token } as never);
  return { ctrl, applied };
};

describe('Хук сервиса мессенджеров', () => {
  it('без MESSENGER_TOKEN отклоняет любые события', async () => {
    const { ctrl, applied } = make('');
    await expect(ctrl.hook(undefined, { events: [{ type: 'message' } as never] })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ctrl.hook('', { events: [] })).rejects.toBeInstanceOf(ForbiddenException);
    expect(applied).toEqual([]);
  });

  it('принимает только верный токен', async () => {
    const { ctrl, applied } = make(TOKEN);
    await expect(ctrl.hook(undefined, { events: [] })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ctrl.hook('b'.repeat(48), { events: [] })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ctrl.hook(TOKEN.slice(1), { events: [] })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ctrl.hook(TOKEN, { events: [{ type: 'message' } as never] })).resolves.toEqual({ ok: true });
    expect(applied).toHaveLength(1);
  });

  it('сравнение токена: пустые значения не совпадают', () => {
    expect(sameMessengerToken('', '')).toBe(false);
    expect(sameMessengerToken(undefined, TOKEN)).toBe(false);
    expect(sameMessengerToken(TOKEN, TOKEN)).toBe(true);
  });
});
