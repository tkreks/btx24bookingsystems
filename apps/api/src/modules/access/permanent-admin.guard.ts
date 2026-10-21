import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { AccessService } from './access.service.js';

/**
 * Только постоянные администраторы приложения (админы портала + список AppAdmin), без доступа по
 * временному паролю: выдача паролей и список администраторов. Ставится после B24AuthGuard.
 */
@Injectable()
export class PermanentAdminGuard implements CanActivate {
  constructor(private readonly access: AccessService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{ b24?: B24UserContext }>();
    if (!req.b24) return false;
    const a = await this.access.resolve(req.b24);
    if (!a.isAppAdmin || a.tempAdminUntil)
      throw new ForbiddenException({ code: 'NOT_PERMANENT_ADMIN', message: 'Только для постоянных администраторов приложения' });
    return true;
  }
}
