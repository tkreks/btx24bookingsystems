import { ForbiddenException, type CallHandler, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import type { AccessService } from './access.service.js';
import { AppAccessInterceptor } from './app-access.interceptor.js';

function run(o: { user?: object; open?: boolean; canEnter?: boolean }) {
  const access = { canEnter: vi.fn(async () => o.canEnter ?? false) } as unknown as AccessService;
  const reflector = { getAllAndOverride: vi.fn(() => o.open ?? false) } as unknown as Reflector;
  const ctx = {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ b24: o.user }) }),
    getHandler: () => null,
    getClass: () => null,
  } as unknown as ExecutionContext;
  const next: CallHandler = { handle: () => of('ok') };
  return { result: lastValueFrom(new AppAccessInterceptor(access, reflector).intercept(ctx, next)), access };
}

describe('AppAccessInterceptor', () => {
  it('сотрудник не из списка — 403 APP_ACCESS_DENIED', async () => {
    await expect(run({ user: { userId: 1 }, canEnter: false }).result).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('с доступом — запрос проходит', async () => {
    await expect(run({ user: { userId: 1 }, canEnter: true }).result).resolves.toBe('ok');
  });
  it('маршруты без сотрудника (установка, события) и сессия — без проверки', async () => {
    const a = run({});
    await expect(a.result).resolves.toBe('ok');
    expect(a.access.canEnter).not.toHaveBeenCalled();
    await expect(run({ user: { userId: 1 }, open: true }).result).resolves.toBe('ok');
  });
});
