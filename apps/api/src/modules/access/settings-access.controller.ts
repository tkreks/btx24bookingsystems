import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import type { SettingsCodeCreatedDto, SettingsCodeDto } from '@btx24/shared';
import { B24AuthGuard, B24User } from '../bitrix24/auth/b24-auth.guard.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { PermanentAdminGuard } from './permanent-admin.guard.js';
import { SettingsAccessService } from './settings-access.service.js';

/** Сотрудник вводит временный пароль к настройкам. */
@Controller('settings-access')
@UseGuards(B24AuthGuard)
export class SettingsAccessController {
  constructor(private readonly codes: SettingsAccessService) {}

  @Post()
  @HttpCode(200)
  activate(@B24User() user: B24UserContext, @Body() body: unknown): Promise<{ until: string }> {
    return this.codes.activate(user, body);
  }
}

/** Временные пароли — выдают и отзывают только постоянные администраторы приложения. */
@Controller('admin/settings-codes')
@UseGuards(B24AuthGuard, PermanentAdminGuard)
export class SettingsCodesAdminController {
  constructor(private readonly codes: SettingsAccessService) {}

  @Get()
  list(@B24User() user: B24UserContext): Promise<SettingsCodeDto[]> {
    return this.codes.list(user.portal.id);
  }

  @Post()
  create(@B24User() user: B24UserContext, @Body() body: unknown): Promise<SettingsCodeCreatedDto> {
    return this.codes.create(user, body);
  }

  @Delete(':id')
  revoke(@B24User() user: B24UserContext, @Param('id') id: string): Promise<SettingsCodeDto> {
    return this.codes.revoke(user.portal.id, id);
  }
}
