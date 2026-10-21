import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import type { SessionInfo } from '@btx24/shared';
import { B24AuthGuard, B24User } from '../bitrix24/auth/b24-auth.guard.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { B24_CONFIG, type Bitrix24Config } from '../bitrix24/bitrix24.tokens.js';
import { AccessService } from './access.service.js';

@Controller('session')
@UseGuards(B24AuthGuard)
export class SessionController {
  constructor(
    private readonly access: AccessService,
    @Inject(B24_CONFIG) private readonly config: Bitrix24Config,
  ) {}

  @Get()
  async get(@B24User() user: B24UserContext): Promise<SessionInfo> {
    const access = await this.access.resolve(user);
    return {
      portal: { domain: user.portal.domain, timezone: user.portal.timezone },
      user: { id: user.userId, name: user.userName, isAdmin: user.isAdmin },
      canManageApp: access.isAppAdmin,
      settingsAccessUntil: access.tempAdminUntil?.toISOString() ?? null,
      readOnly: this.config.readOnly,
    };
  }
}
