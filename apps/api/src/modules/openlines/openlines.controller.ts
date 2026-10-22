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
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type {
  ChatChannelDto,
  ChatReplyStatusDto,
  CallListDto,
  CallLogDto,
  ChatFolderDto,
  ChatHistoryDto,
  ChatListDto,
  DashboardDto,
  MessageTemplateDto,
  SendResultDto,
  StoredFileDto,
} from '@btx24/shared';
import { AccessService, type UserAccess } from '../access/access.service.js';
import { ActionLogService } from '../audit/action-log.service.js';
import { B24AuthGuard, B24User } from '../bitrix24/auth/b24-auth.guard.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { ChatFoldersService } from './chat-folders.service.js';
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
    private readonly folderService: ChatFoldersService,
    private readonly actions: ActionLogService,
  ) {}

  @Get('dashboard')
  async summary(
    @B24User() user: B24UserContext,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('callsScope') callsScope?: string,
    @Query('callsFunnel') callsFunnel?: string,
    @Query('part') part?: string,
  ): Promise<Partial<DashboardDto>> {
    const a = await this.access.resolve(user);
    if (!a.isAppAdmin && !a.groups.length)
      throw new ForbiddenException({ code: 'NO_GROUP_ACCESS', message: 'Вы не состоите ни в одной группе приложения' });
    return this.dashboard.get(
      user,
      { from, to, callsScope, callsFunnel, part },
      await this.can(user, 'openlines.read'),
      funnelsOf(a),
      // Брони — по ресурсам групп сотрудника; администратору приложения — все.
      a.isAppAdmin ? null : [...new Set(a.groups.flatMap((g) => g.group.resourceIds))],
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

  /** Журнал звонков дня (окно «Показать звонки» на дашборде). */
  @Get('dashboard/call-log')
  async callLog(@B24User() user: B24UserContext, @Query() query: Record<string, unknown>): Promise<CallLogDto> {
    const a = await this.access.resolve(user);
    if (!a.isAppAdmin && !a.groups.length)
      throw new ForbiddenException({ code: 'NO_GROUP_ACCESS', message: 'Вы не состоите ни в одной группе приложения' });
    return this.dashboard.callLog(user, query);
  }

  @Get('openlines/chats')
  async list(@B24User() user: B24UserContext, @Query() query: unknown): Promise<ChatListDto> {
    await this.require(user, 'openlines.read');
    return this.chats.list(user, query);
  }

  /** Мои папки чатов — со сводкой (последнее сообщение, непрочитанные). */
  @Get('openlines/folders')
  async folders(@B24User() user: B24UserContext): Promise<ChatFolderDto[]> {
    await this.require(user, 'openlines.read');
    return this.folderService.list(user);
  }

  @Post('openlines/folders')
  async folderCreate(@B24User() user: B24UserContext, @Body() body: unknown): Promise<{ id: string }> {
    await this.require(user, 'openlines.read');
    return this.folderService.create(user, body);
  }

  @Put('openlines/folders/:id')
  @HttpCode(204)
  async folderRename(@B24User() user: B24UserContext, @Param('id') id: string, @Body() body: unknown): Promise<void> {
    await this.require(user, 'openlines.read');
    await this.folderService.rename(user, id, body);
  }

  @Delete('openlines/folders/:id')
  @HttpCode(204)
  async folderDelete(@B24User() user: B24UserContext, @Param('id') id: string): Promise<void> {
    await this.require(user, 'openlines.read');
    await this.folderService.remove(user, id);
  }

  /** Положить чат в папку (перенести из другой). */
  @Put('openlines/folders/:id/chats/:chatId')
  @HttpCode(204)
  async folderPut(
    @B24User() user: B24UserContext,
    @Param('id') id: string,
    @Param('chatId', ParseIntPipe) chatId: number,
  ): Promise<void> {
    await this.require(user, 'openlines.read');
    await this.folderService.put(user, id, chatId);
  }

  /** Вернуть чат в общий список. */
  @Delete('openlines/folder-chats/:chatId')
  @HttpCode(204)
  async folderTakeOut(@B24User() user: B24UserContext, @Param('chatId', ParseIntPipe) chatId: number): Promise<void> {
    await this.require(user, 'openlines.read');
    await this.folderService.takeOut(user, chatId);
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

  /** Файл сообщения (картинки и видео в чате приложения) — через сервер, с правами сотрудника. */
  @Get('openlines/chats/:chatId/files/:fileId')
  async file(
    @B24User() user: B24UserContext,
    @Param('chatId', ParseIntPipe) chatId: number,
    @Param('fileId', ParseIntPipe) fileId: number,
    @Res({ passthrough: true }) res: { setHeader(name: string, value: string): void },
  ): Promise<StreamableFile> {
    await this.require(user, 'openlines.read');
    const f = await this.chats.file(user, chatId, fileId);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return new StreamableFile(f.data, { type: f.contentType ?? 'application/octet-stream', length: f.data.length });
  }

  /** Переменные шаблона по сделке чата — до отправки, чтобы сотрудник видел готовый текст. */
  @Post('openlines/chats/:chatId/render')
  async render(@B24User() user: B24UserContext, @Param('chatId', ParseIntPipe) chatId: number, @Body() body: unknown) {
    await this.require(user, 'openlines.send');
    return this.chats.render(user, chatId, body);
  }

  /** Другие открытые линии того же клиента — переключатель мессенджера в чате. */
  @Get('openlines/chats/:chatId/channels')
  async channels(@B24User() user: B24UserContext, @Param('chatId', ParseIntPipe) chatId: number): Promise<ChatChannelDto[]> {
    await this.require(user, 'openlines.read');
    return this.chats.channels(user, chatId);
  }

  /** «Не требует ответа» / снова «ждёт ответа» — одна отметка для всех сотрудников. */
  @Put('openlines/chats/:chatId/reply-status')
  async replyStatus(@B24User() user: B24UserContext, @Param('chatId', ParseIntPipe) chatId: number, @Body() body: unknown): Promise<ChatReplyStatusDto> {
    await this.require(user, 'openlines.read');
    const r = await this.chats.setReplyStatus(user, chatId, body);
    await this.actions.user(user, {
      action: 'chat.reply_status',
      summary: r.noReply ? `Отметил чат #${chatId}: «Не требует ответа»` : `Вернул чату #${chatId} статус «Ждёт ответа»`,
      entityType: 'chat',
      entityId: chatId,
    });
    return r;
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

  @Get('openlines/templates/variables')
  async templateVariables(@B24User() user: B24UserContext) {
    await this.require(user, 'openlines.send');
    return this.chats.variables(user);
  }

  @Post('openlines/templates/preview')
  async templatePreview(@B24User() user: B24UserContext, @Body() body: unknown) {
    await this.require(user, 'openlines.send');
    return this.chats.preview(user, body);
  }

  @Get('openlines/templates')
  async templateList(@B24User() user: B24UserContext): Promise<MessageTemplateDto[]> {
    await this.require(user, 'openlines.send');
    return this.templates.list(user, await this.isAdmin(user));
  }

  @Post('openlines/templates')
  async templateCreate(@B24User() user: B24UserContext, @Body() body: unknown): Promise<MessageTemplateDto> {
    await this.require(user, 'openlines.send');
    return this.templates.create(user, body, await this.isAdmin(user));
  }

  @Put('openlines/templates/:id')
  async templateUpdate(
    @B24User() user: B24UserContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<MessageTemplateDto> {
    await this.require(user, 'openlines.send');
    return this.templates.update(user, id, body, await this.isAdmin(user));
  }

  @Delete('openlines/templates/:id')
  @HttpCode(204)
  async templateDelete(@B24User() user: B24UserContext, @Param('id') id: string): Promise<void> {
    await this.require(user, 'openlines.send');
    await this.templates.remove(user, id, await this.isAdmin(user));
  }

  /** Администратор приложения — меняет общие шаблоны. */
  private async isAdmin(user: B24UserContext): Promise<boolean> {
    return (await this.access.resolve(user)).isAppAdmin;
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
