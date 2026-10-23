import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import type { SessionInfo } from '@btx24/shared';
import { B24AuthGuard, B24User } from '../bitrix24/auth/b24-auth.guard.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { B24_CONFIG, type Bitrix24Config } from '../bitrix24/bitrix24.tokens.js';
import { photoUrl } from '../bitrix24/rest/photo-url.js';
import { AccessService } from './access.service.js';
import { OpenWithoutAppAccess } from './app-access.interceptor.js';

const PHOTO_TTL_MS = 10 * 60_000;

@Controller('session')
@UseGuards(B24AuthGuard)
@OpenWithoutAppAccess()
export class SessionController {
  constructor(
    private readonly access: AccessService,
    @Inject(B24_CONFIG) private readonly config: Bitrix24Config,
  ) {}

  /** Аватарки сотрудников (шапка дашбордов) — на 10 минут, без лишнего user.current. */
  private readonly photos = new Map<string, { url: string | null; expiresAt: number }>();

  @Get()
  async get(@B24User() user: B24UserContext): Promise<SessionInfo> {
    const [access, photo] = await Promise.all([this.access.resolve(user), this.photo(user)]);
    return {
      portal: { domain: user.portal.domain, timezone: user.portal.timezone },
      user: { id: user.userId, name: user.userName, isAdmin: user.isAdmin, photo },
      canManageApp: access.isAppAdmin,
      appAccess: access.canEnter,
      settingsAccessUntil: access.tempAdminUntil?.toISOString() ?? null,
      readOnly: this.config.readOnly,
      isHead: access.isHead,
      headAssigned: access.headAssigned,
    };
  }

  private async photo(user: B24UserContext): Promise<string | null> {
    const key = `${user.portal.id}:${user.userId}`;
    const hit = this.photos.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.url;
    // Без фото — инициалы; сбой запроса сессию не ломает.
    const res = await user.client.call<{ PERSONAL_PHOTO?: string | null }>('user.current').catch(() => null);
    const url = photoUrl(res?.result?.PERSONAL_PHOTO, user.portal.domain);
    if (this.photos.size > 2000) this.photos.clear();
    this.photos.set(key, { url, expiresAt: Date.now() + PHOTO_TTL_MS });
    return url;
  }
}
