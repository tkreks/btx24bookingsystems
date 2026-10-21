import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type {
  CallListDto,
  ChatHistoryDto,
  ChatListDto,
  DashboardDto,
  MessageTemplateDto,
  SendResultDto,
  StoredFileDto,
} from '@btx24/shared';
import { AccessService, type UserAccess } from '../access/access.service.js';
import { B24AuthGuard, B24User } from '../bitrix24/auth/b24-auth.guard.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { ChatsService } from './chats.service.js';
import { DashboardService } from './dashboard.service.js';
import { FilesService, MAX_FILE_BYTES, type UploadedFile as Upload } from './files.service.js';
import { TemplatesService } from './templates.service.js';

/** Воронки групп пользователя (уникальные, в порядке групп). */
function funnelsOf(a: UserAccess): number[] {
  return [...new Set(a.groups.map((g) => g.group.dealCategoryId).filter((x): x is number => x !== null))];
}

/**
 * Открытые линии. Право — `openlines.read` / `openlines.send` хотя бы в одной группе (или
 * администратор приложения); что именно видно и можно — решает Битрикс24 по токену пользователя.
 */
@Controller()
@UseGuards(B24AuthGuard)
export class OpenlinesController {
  constructor(
    private readonly access: AccessService,
    private readonly chats: ChatsService,
    private readonly templates: TemplatesService,
    private readonly files: FilesService,
    private readonly dashboard: DashboardService,
  ) {}

  @Get('dashboard')
  async summary(
    @B24User() user: B24UserContext,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('callsScope') callsScope?: string,
    @Query('callsFunnel') callsFunnel?: string,
  ): Promise<DashboardDto> {
    const a = await this.access.resolve(user);
    if (!a.isAppAdmin && !a.groups.length)
      throw new ForbiddenException({ code: 'NO_GROUP_ACCESS', message: 'Вы не состоите ни в одной группе приложения' });
    return this.dashboard.get(
      user,
      { from, to, callsScope, callsFunnel },
      await this.can(user, 'openlines.read'),
      funnelsOf(a),
    );
  }

  /** Звонки выбранного вида за период (окно «сделки» на дашборде). */
  @Get('dashboard/calls')
  async calls(@B24User() user: B24UserContext, @Query() query: Record<string, unknown>): Promise<CallListDto> {
    const a = await this.access.resolve(user);
    if (!a.isAppAdmin && !a.groups.length)
      throw new ForbiddenException({ code: 'NO_GROUP_ACCESS', message: 'Вы не состоите ни в одной группе приложения' });
    return this.dashboard.callList(user, query, funnelsOf(a));
  }

  @Get('openlines/chats')
  async list(@B24User() user: B24UserContext, @Query() query: unknown): Promise<ChatListDto> {
    await this.require(user, 'openlines.read');
    return this.chats.list(user, query);
  }

  /** Поиск по номеру телефона клиента по всему порталу (`?q=`). */
  @Get('openlines/chats/search')
  async search(@B24User() user: B24UserContext, @Query() query: unknown): Promise<ChatListDto> {
    await this.require(user, 'openlines.read');
    return this.chats.searchByPhone(user, query);
  }

  @Get('openlines/chats/:chatId/messages')
  async history(
    @B24User() user: B24UserContext,
    @Param('chatId', ParseIntPipe) chatId: number,
    @Query() query: unknown,
  ): Promise<ChatHistoryDto> {
    await this.require(user, 'openlines.read');
    return this.chats.history(user, chatId, query, await this.can(user, 'openlines.send'));
  }

  @Post('openlines/chats/:chatId/join')
  @HttpCode(204)
  async join(@B24User() user: B24UserContext, @Param('chatId', ParseIntPipe) chatId: number): Promise<void> {
    await this.require(user, 'openlines.send');
    await this.chats.join(user, chatId);
  }

  @Post('openlines/chats/:chatId/send')
  async send(
    @B24User() user: B24UserContext,
    @Param('chatId', ParseIntPipe) chatId: number,
    @Body() body: unknown,
  ): Promise<SendResultDto> {
    await this.require(user, 'openlines.send');
    return this.chats.send(user, chatId, body);
  }

  @Post('openlines/files')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_BYTES, files: 1 } }))
  async upload(@B24User() user: B24UserContext, @UploadedFile() file: Upload | undefined): Promise<StoredFileDto> {
    await this.require(user, 'openlines.send');
    return this.files.upload(user, file);
  }

  @Get('openlines/templates')
  async templateList(@B24User() user: B24UserContext): Promise<MessageTemplateDto[]> {
    await this.require(user, 'openlines.send');
    return this.templates.list(user);
  }

  @Post('openlines/templates')
  async templateCreate(@B24User() user: B24UserContext, @Body() body: unknown): Promise<MessageTemplateDto> {
    await this.require(user, 'openlines.send');
    return this.templates.create(user, body);
  }

  @Put('openlines/templates/:id')
  async templateUpdate(
    @B24User() user: B24UserContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<MessageTemplateDto> {
    await this.require(user, 'openlines.send');
    return this.templates.update(user, id, body);
  }

  @Delete('openlines/templates/:id')
  @HttpCode(204)
  async templateDelete(@B24User() user: B24UserContext, @Param('id') id: string): Promise<void> {
    await this.require(user, 'openlines.send');
    await this.templates.remove(user, id);
  }

  private async can(user: B24UserContext, permission: 'openlines.read' | 'openlines.send'): Promise<boolean> {
    const a = await this.access.resolve(user);
    return a.isAppAdmin || this.access.pick(a, undefined, permission) !== null;
  }

  private async require(user: B24UserContext, permission: 'openlines.read' | 'openlines.send'): Promise<void> {
    if (!(await this.can(user, permission)))
      throw new ForbiddenException({
        code: 'NO_OPENLINES_ACCESS',
        message:
          permission === 'openlines.send'
            ? 'Нет права отправлять сообщения в открытые линии'
            : 'Нет доступа к открытым линиям',
      });
  }
}
