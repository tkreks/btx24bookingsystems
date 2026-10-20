import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import type { SessionInfo } from '@btx24/shared';
import { B24AuthGuard, B24User } from '../auth/b24-auth.guard.js';
import type { B24UserContext } from '../auth/user-context.js';
import { B24_CONFIG, type Bitrix24Config } from '../bitrix24.tokens.js';

@Controller('session')
@UseGuards(B24AuthGuard)
export class SessionController {
  constructor(@Inject(B24_CONFIG) private readonly config: Bitrix24Config) {}

  @Get()
  get(@B24User() user: B24UserContext): SessionInfo {
    return {
      portal: { domain: user.portal.domain, timezone: user.portal.timezone },
      user: { id: user.userId, name: user.userName, isAdmin: user.isAdmin },
      readOnly: this.config.readOnly,
    };
  }
}
