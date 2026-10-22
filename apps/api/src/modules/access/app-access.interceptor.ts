import { CallHandler, ExecutionContext, ForbiddenException, Injectable, NestInterceptor, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { from, mergeMap, type Observable } from 'rxjs';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { AccessService } from './access.service.js';

const OPEN_WITHOUT_APP_ACCESS = 'btx24:openWithoutAppAccess';
/** Маршрут доступен и без доступа к приложению (сессия — чтобы показать «Доступ ограничен»). */
export const OpenWithoutAppAccess = () => SetMetadata(OPEN_WITHOUT_APP_ACCESS, true);

/**
 * Доступ к приложению (решение владельца 2026-10-22): каждый запрос сотрудника портала (после
 * `B24AuthGuard`) — только администраторам и сотрудникам из списка доступа (⚙ → «Приложение»).
 * Глобальный перехватчик: срабатывает после guard'ов, поэтому контекст сотрудника уже есть;
 * маршруты без него (установка, события Битрикс24) не затрагивает.
 */
@Injectable()
export class AppAccessInterceptor implements NestInterceptor {
  constructor(
    private readonly access: AccessService,
    private readonly reflector: Reflector,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const user = ctx.switchToHttp().getRequest<{ b24?: B24UserContext }>().b24;
    if (!user || this.reflector.getAllAndOverride<boolean>(OPEN_WITHOUT_APP_ACCESS, [ctx.getHandler(), ctx.getClass()])) return next.handle();
    return from(this.access.canEnter(user)).pipe(
      mergeMap((ok) => {
        if (!ok) throw new ForbiddenException({ code: 'APP_ACCESS_DENIED', message: 'Доступ к приложению ограничен. Обратитесь к администратору портала.' });
        return next.handle();
      }),
    );
  }
}
