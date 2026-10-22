import { CanActivate, ExecutionContext, Injectable, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import { AUTH_HEADER, MEMBER_HEADER, STANDALONE_HEADER, type B24UserContext } from './user-context.js';
import { AuthError, UserTokenVerifier } from './user-token.verifier.js';
import { SESSION_COOKIE, WebSessionService, readCookie } from './web-session.service.js';

type B24Request = Request & { b24?: B24UserContext };

/**
 * Guard пользовательских эндпоинтов: `Authorization: Bearer <AUTH_ID>` + `X-B24-Member-Id` (из фрейма)
 * либо cookie сессии входа через Битрикс24 вне портала (`WebSessionService`). Для cookie-сессии
 * обязателен заголовок `X-Btx24-Standalone`: чужой сайт не может поставить его на запрос с
 * cookie без CORS-разрешения — так закрыта подделка запросов (CSRF).
 * Ставится на каждый контроллер с данными портала (`@UseGuards(B24AuthGuard)`).
 */
@Injectable()
export class B24AuthGuard implements CanActivate {
  constructor(
    private readonly verifier: UserTokenVerifier,
    private readonly sessions: WebSessionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<B24Request>();
    const auth = String(req.headers[AUTH_HEADER] ?? '');
    const memberId = String(req.headers[MEMBER_HEADER] ?? '').trim();
    const token = /^Bearer\s+(\S+)$/i.exec(auth)?.[1];
    const session = token ? undefined : readCookie(req.headers.cookie, SESSION_COOKIE);
    if (session) {
      if (req.headers[STANDALONE_HEADER] !== '1') throw new AuthError('UNAUTHORIZED', 'Откройте приложение из Битрикс24');
      const s = await this.sessions.resolve(session);
      req.b24 = await this.verifier.verify(s.portal.memberId, s.accessToken);
      return true;
    }
    if (!token || !/^[a-z0-9]{8,64}$/i.test(memberId)) throw new AuthError('UNAUTHORIZED', 'Откройте приложение из Битрикс24');
    req.b24 = await this.verifier.verify(memberId, token);
    return true;
  }
}

/** Контекст пользователя в обработчике: `handler(@B24User() user: B24UserContext)`. */
export const B24User = createParamDecorator((_: unknown, ctx: ExecutionContext): B24UserContext => {
  const req = ctx.switchToHttp().getRequest<B24Request>();
  if (!req.b24) throw new AuthError('UNAUTHORIZED', 'B24AuthGuard is not applied to this route');
  return req.b24;
});
