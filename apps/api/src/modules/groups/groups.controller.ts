import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, UseGuards } from '@nestjs/common';
import type { AppSettingsDto, GroupDto, MyGroupDto } from '@btx24/shared';
import { AccessService } from '../access/access.service.js';
import { AppAdminGuard } from '../access/app-admin.guard.js';
import { B24AuthGuard, B24User } from '../bitrix24/auth/b24-auth.guard.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { GroupsService } from './groups.service.js';

/** Группы текущего пользователя: что он видит и может. */
@Controller('groups')
@UseGuards(B24AuthGuard)
export class MyGroupsController {
  constructor(private readonly access: AccessService) {}

  @Get()
  async mine(@B24User() user: B24UserContext): Promise<MyGroupDto[]> {
    const a = await this.access.resolve(user);
    return a.groups.map((g) => this.access.toDto(g));
  }
}

/** Настройки групп и приложения — только администраторы приложения. */
@Controller('admin')
@UseGuards(B24AuthGuard, AppAdminGuard)
export class GroupsAdminController {
  constructor(private readonly groups: GroupsService) {}

  @Get('groups')
  list(@B24User() user: B24UserContext): Promise<GroupDto[]> {
    return this.groups.list(user.portal.id);
  }

  @Post('groups')
  create(@B24User() user: B24UserContext, @Body() body: unknown): Promise<GroupDto> {
    return this.groups.create(user.portal.id, body);
  }

  @Put('groups/:id')
  update(@B24User() user: B24UserContext, @Param('id') id: string, @Body() body: unknown): Promise<GroupDto> {
    return this.groups.update(user.portal.id, id, body);
  }

  @Delete('groups/:id')
  @HttpCode(204)
  archive(@B24User() user: B24UserContext, @Param('id') id: string): Promise<void> {
    return this.groups.archive(user.portal.id, id);
  }

  @Get('settings')
  settings(@B24User() user: B24UserContext): Promise<AppSettingsDto> {
    return this.groups.settings(user.portal.id);
  }

  @Put('settings')
  save(@B24User() user: B24UserContext, @Body() body: unknown): Promise<AppSettingsDto> {
    return this.groups.saveSettings(user.portal.id, user.userId, body);
  }
}
