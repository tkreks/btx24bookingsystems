import { CanActivate, ExecutionContext, Injectable, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import { STANDALONE_HEADER } from '../bitrix24/auth/user-context.js';
import { AuthError } from '../bitrix24/auth/user-token.verifier.js';
import { readCookie } from '../bitrix24/auth/web-session.service.js';
import { EXTERNAL_COOKIE, ExternalAuthService, type ExternalUserContext } from './external-auth.service.js';

type ExternalRequest = Request & { external?: ExternalUserContext };

/**
 * Guard экранов внешнего пользователя: cookie `btx24_ext` + заголовок `X-Btx24-Standalone` (как у
 * входа сотрудников вне портала — чужой сайт не поставит его без CORS, CSRF закрыт). Токена Битрикс24
 * у внешнего пользователя нет: доступ решают его настройки (группы, видимые поля).
 */
@Injectable()
export class ExternalAuthGuard implements CanActivate {
  constructor(private readonly auth: ExternalAuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<ExternalRequest>();
    const secret = readCookie(req.headers.cookie, EXTERNAL_COOKIE);
    if (!secret || req.headers[STANDALONE_HEADER] !== '1') throw new AuthError('UNAUTHORIZED', 'Войдите по логину и паролю');
    req.external = await this.auth.resolve(secret);
    return true;
  }
}

export const ExternalUser = createParamDecorator((_: unknown, ctx: ExecutionContext): ExternalUserContext => {
  const req = ctx.switchToHttp().getRequest<ExternalRequest>();
  if (!req.external) throw new AuthError('UNAUTHORIZED', 'ExternalAuthGuard is not applied to this route');
  return req.external;
});
