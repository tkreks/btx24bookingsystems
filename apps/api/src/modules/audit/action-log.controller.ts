import { BadRequestException, Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import type { ActionLogDto } from '@btx24/shared';
import { z } from 'zod';
import { AccessService } from '../access/access.service.js';
import { AppAdminGuard } from '../access/app-admin.guard.js';
import { OpenWithoutAppAccess } from '../access/app-access.interceptor.js';
import { B24AuthGuard, B24User } from '../bitrix24/auth/b24-auth.guard.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { ActionLogService } from './action-log.service.js';

const PLACEMENTS: Record<string, string> = {
  CRM_DEAL_DETAIL_TAB: 'из карточки сделки',
  CRM_CONTACT_DETAIL_TAB: 'из карточки контакта',
  LEFT_MENU: 'из левого меню',
  DEFAULT: 'из списка приложений',
};
const errorSchema = z.object({ where: z.string().max(64), message: z.string().max(500), stack: z.string().max(4000), build: z.string().max(64) }).strict();
const enterSchema = z.object({ placement: z.string().max(64), dealId: z.number().int().positive().nullable() }).strict();

/** Журнал действий: вход в приложение (пишет каждый) и просмотр (администраторы приложения). */
@Controller()
@UseGuards(B24AuthGuard)
export class ActionLogController {
  constructor(
    private readonly log: ActionLogService,
    private readonly access: AccessService,
  ) {}

  /** Сотрудник открыл приложение: откуда (сделка, меню). Без доступа — тоже пишется (попытка). */
  @Post('activity/enter')
  @OpenWithoutAppAccess()
  async enter(@B24User() user: B24UserContext, @Body() body: unknown): Promise<{ ok: true }> {
    const p = enterSchema.safeParse(body);
    if (!p.success) throw new BadRequestException({ code: 'INVALID_ENTER', message: 'Ожидается { placement, dealId }' });
    const allowed = await this.access.canEnter(user);
    const where = p.data.dealId ? `из сделки #${p.data.dealId}` : (PLACEMENTS[p.data.placement] ?? `(${p.data.placement})`);
    await this.log.user(user, {
      action: allowed ? 'app.enter' : 'app.denied',
      summary: allowed ? `Вошёл в приложение ${where}` : `Попытка входа без доступа ${where}`,
      ...(p.data.dealId ? { entityType: 'deal', entityId: p.data.dealId } : {}),
      details: { placement: p.data.placement, isPortalAdmin: user.isAdmin },
      via: p.data.placement,
    });
    return { ok: true };
  }

  /** Интерфейс упал (перехватчик ошибок) — в журнал с трассой, чтобы найти причину. */
  @Post('activity/error')
  @OpenWithoutAppAccess()
  async error(@B24User() user: B24UserContext, @Body() body: unknown): Promise<{ ok: true }> {
    const p = errorSchema.safeParse(body);
    if (!p.success) throw new BadRequestException({ code: 'INVALID_ERROR_REPORT', message: 'Ожидается { where, message, stack, build }' });
    await this.log.user(user, { action: 'app.error', summary: `Ошибка интерфейса (${p.data.where}): ${p.data.message}`, details: { stack: p.data.stack, build: p.data.build }, via: 'web' });
    return { ok: true };
  }

  @Get('admin/action-log')
  @UseGuards(AppAdminGuard)
  list(@B24User() user: B24UserContext, @Query() query: Record<string, unknown>): Promise<ActionLogDto> {
    return this.log.list(user.portal.id, user.portal.timezone, query);
  }
}
