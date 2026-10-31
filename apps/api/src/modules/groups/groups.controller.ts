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
import { ActionLogService, diffFields } from '../audit/action-log.service.js';
import { AppAdminGuard } from '../access/app-admin.guard.js';
import { PermanentAdminGuard } from '../access/permanent-admin.guard.js';
import { B24AuthGuard, B24User } from '../bitrix24/auth/b24-auth.guard.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { GroupDirectoryService } from './group-directory.service.js';
import { ExternalPasswordsService } from './external-passwords.service.js';
import { FilesService } from '../openlines/files.service.js';
import { groupSettingsSchema } from './groups.schemas.js';
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
    private readonly actions: ActionLogService,
    private readonly files: FilesService,
  ) {}

  private async checkFiles(user: B24UserContext, body: unknown): Promise<void> {
    const parsed = groupSettingsSchema.safeParse(body);
    if (!parsed.success) return; // Понятная ошибка полной схемы — в GroupsService.
    const ids = [...new Set((parsed.data.options?.bookingTypes ?? []).flatMap((r) => [...r.confirmation, ...(r.prepayment ?? [])].flatMap((s) => s.files.flatMap((f) => 'storedFileId' in f ? [f.storedFileId] : []))))];
    await this.files.assertOwned(user, ids);
  }

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
  async create(@B24User() user: B24UserContext, @Body() body: unknown): Promise<GroupDto> {
    await this.checkFiles(user, body);
    const g = await this.groups.create(user.portal.id, body);
    await this.actions.user(user, { action: 'group.create', summary: `Создал группу «${g.name}»`, entityType: 'group', entityId: g.id, details: { after: g } });
    return g;
  }

  @Put('groups-order')
  async reorder(@B24User() user: B24UserContext, @Body() body: unknown): Promise<GroupDto[]> {
    const ids = (body as { ids?: unknown } | null)?.ids;
    const before = await this.groups.list(user.portal.id);
    const after = await this.groups.reorder(user.portal.id, ids);
    await this.actions.user(user, {
      action: 'group.reorder',
      summary: `Изменил порядок групп: ${after.map((g) => g.name).join(', ')}`,
      entityType: 'group',
      details: { before: before.map((g) => g.name), after: after.map((g) => g.name) },
    });
    return after;
  }

  @Put('groups/:id')
  async update(@B24User() user: B24UserContext, @Param('id') id: string, @Body() body: unknown): Promise<GroupDto> {
    const before = (await this.groups.list(user.portal.id)).find((g) => g.id === id) ?? null;
    await this.checkFiles(user, body);
    const g = await this.groups.update(user.portal.id, id, body);
    // «Было → стало» по разделам группы; настройки направления (options) — по их блокам.
    const flat = (x: GroupDto | null) => (x ? { ...x, ...Object.fromEntries(Object.entries(x.options ?? {}).map(([k, v]) => [`options.${k}`, v])), options: undefined } : null);
    const changes = diffFields(flat(before), flat(g)!, GROUP_LABELS, ['sort', 'id']);
    await this.actions.user(user, {
      action: 'group.update',
      summary: `Изменил группу «${g.name}»${changes.length ? `: ${changes.map((c) => c.label).join(', ')}` : ' (без изменений)'}`,
      entityType: 'group',
      entityId: g.id,
      details: { changes },
    });
    return g;
  }

  @Delete('groups/:id')
  @HttpCode(204)
  async archive(@B24User() user: B24UserContext, @Param('id') id: string): Promise<void> {
    const before = (await this.groups.list(user.portal.id)).find((g) => g.id === id);
    await this.groups.archive(user.portal.id, id);
    await this.actions.user(user, { action: 'group.archive', summary: `Архивировал группу «${before?.name ?? id}»`, entityType: 'group', entityId: id });
  }

  @Get('settings')
  settings(@B24User() user: B24UserContext): Promise<AppSettingsDto> {
    return this.groups.settings(user.portal.id);
  }

  /** Список администраторов меняют только постоянные администраторы (не по временному паролю). */
  @Put('settings')
  @UseGuards(PermanentAdminGuard)
  async save(@B24User() user: B24UserContext, @Body() body: unknown): Promise<AppSettingsDto> {
    const before = await this.groups.settings(user.portal.id);
    const after = await this.groups.saveSettings(user.portal.id, user.userId, body);
    const changes = diffFields({ ...before }, { ...after }, SETTINGS_LABELS);
    await this.actions.user(user, {
      action: 'settings.update',
      summary: `Изменил настройки приложения${changes.length ? `: ${changes.map((c) => c.label).join(', ')}` : ' (без изменений)'}`,
      entityType: 'settings',
      details: { changes },
    });
    return after;
  }
}

/** Подписи разделов для «было → стало» в журнале действий. */
const GROUP_LABELS: Record<string, string> = {
  name: 'название',
  dealCategoryId: 'воронка',
  resourceIds: 'ресурсы',
  bookingMode: 'режим времени',
  durationMinutes: 'длительность',
  checkInTime: 'заезд',
  checkOutTime: 'выезд',
  defaultNights: 'ночей по умолчанию',
  techWindowMinutes: 'тех. окно',
  features: 'функции',
  members: 'участники',
  'options.dealFields': 'поля сделки',
  'options.productSectionIds': 'разделы каталога',
  'options.resourceDefaults': 'товары по умолчанию',
  'options.views': 'вид календаря',
  'options.bookingTypes': 'типы брони и сообщения',
  'options.bookingTypeRequired': 'обязательный тип брони',
  'options.dealKinds': 'шаг «Тип сделки» в мастере',
  'options.productSectionsHidden': 'разделы каталога, скрытые из быстрых тегов',
  'options.payments': 'оплаты',
};
const SETTINGS_LABELS: Record<string, string> = {
  dialogMetadataEnabled: 'сбор метаданных диалогов',
  dialogTextsEnabled: 'сбор текстов',
  removeWazzupEmail: 'удаление e-mail wazzup',
  admins: 'администраторы',
  appUsers: 'доступ к приложению',
  heads: 'руководители',
};
