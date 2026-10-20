import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { AccessService } from './access.service.js';

/** Только администраторы приложения (админы портала + список AppAdmin). Ставится после B24AuthGuard. */
@Injectable()
export class AppAdminGuard implements CanActivate {
  constructor(private readonly access: AccessService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{ b24?: B24UserContext }>();
    if (!req.b24) return false;
    const access = await this.access.resolve(req.b24);
    if (!access.isAppAdmin) throw new ForbiddenException({ code: 'NOT_APP_ADMIN', message: 'Только для администраторов приложения' });
    return true;
  }
}
