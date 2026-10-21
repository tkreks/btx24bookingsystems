import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import type {
  AppSettingsDto,
  CatalogDto,
  DealFieldInfo,
  DealStageItem,
  EmployeeDto,
  ExternalUserSummaryDto,
  GroupDirectoryDto,
  GroupDto,
  MyGroupDto,
} from '@btx24/shared';
import { AccessService } from '../access/access.service.js';
import { AppAdminGuard } from '../access/app-admin.guard.js';
import { B24AuthGuard, B24User } from '../bitrix24/auth/b24-auth.guard.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { GroupDirectoryService } from './group-directory.service.js';
import { ExternalPasswordsService } from './external-passwords.service.js';
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
  constructor(
    private readonly groups: GroupsService,
    private readonly directory: GroupDirectoryService,
    private readonly passwords: ExternalPasswordsService,
  ) {}

  @Get('group-directory')
  references(@B24User() user: B24UserContext): Promise<GroupDirectoryDto> {
    return this.directory.get(user);
  }

  @Get('employees')
  employees(@B24User() user: B24UserContext, @Query() query: unknown): Promise<EmployeeDto[]> {
    return this.directory.employees(user, query);
  }

  @Get('deal-fields')
  dealFields(@B24User() user: B24UserContext): Promise<DealFieldInfo[]> {
    return this.directory.dealFields(user);
  }

  @Get('deal-stages')
  dealStages(@B24User() user: B24UserContext, @Query() query: unknown): Promise<DealStageItem[]> {
    return this.directory.dealStages(user, query);
  }

  @Get('catalog')
  catalog(@B24User() user: B24UserContext): Promise<CatalogDto> {
    return this.directory.catalog(user);
  }

  @Get('external-users')
  externalUsers(@B24User() user: B24UserContext): Promise<ExternalUserSummaryDto[]> {
    return this.passwords.list(user.portal.id);
  }

  @Put('external-users/:id/password')
  @HttpCode(204)
  changePassword(@B24User() user: B24UserContext, @Param('id') id: string, @Body() body: unknown): Promise<void> {
    return this.passwords.change(user.portal.id, id, body);
  }

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
