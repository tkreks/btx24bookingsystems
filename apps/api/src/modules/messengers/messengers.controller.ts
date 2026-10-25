import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Headers, HttpCode, NotFoundException, Param, Post, Put, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MESSENGER_MAX_FILE_BYTES } from '@btx24/shared';
import { MessengerCrmService } from './messenger-crm.service.js';
import { MediaLinks } from './media-links.js';
import type { Response } from 'express';
import type { CreateMessengerDto, MessengerChatDto, MessengerDto, MessengerLinkDto, MessengerMessageDto, MessengerSendDto, MessengerSendResultDto, MessengerVncTicketDto } from '@btx24/shared';
import { MessengerChatsService } from './messenger-chats.service.js';
import { MessengerInboxService } from './messenger-inbox.service.js';
import { MessengerServiceClient, type WireEvent } from './messenger-service.client.js';
import { PermanentAdminGuard } from '../access/permanent-admin.guard.js';
import { B24AuthGuard, B24User } from '../bitrix24/auth/b24-auth.guard.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { MessengersService, toDto } from './messengers.service.js';

/**
 * ⚙ → «Мессенджеры» (ADR 0014): подключённые к порталу мессенджеры. Только постоянные администраторы
 * приложения — подключение мессенджера даёт писать от имени номера компании.
 */
@Controller('admin/messengers')
@UseGuards(B24AuthGuard, PermanentAdminGuard)
export class MessengersController {
  constructor(
    private readonly messengers: MessengersService,
    private readonly chatsService: MessengerChatsService,
    private readonly crm: MessengerCrmService,
  ) {}

  /** Своя открытая линия: создать и привязать (`mode: own`) или отвязать (`mode: null`). */
  @Put(':id/line')
  async link(@B24User() user: B24UserContext, @Param('id') id: string, @Body() body: MessengerLinkDto): Promise<MessengerDto> {
    await this.chatsService.link(user, id, body);
    return (await this.messengers.list(user.portal.id)).find((m) => m.id === id)!;
  }

  /** Группы, которым доступен номер в приложении. */
  @Put(':id/groups')
  async groups(@B24User() user: B24UserContext, @Param('id') id: string, @Body() body: { groupIds?: unknown }): Promise<MessengerDto> {
    return toDto(await this.chatsService.setGroups(user.portal.id, id, body?.groupIds), null);
  }

  @Get(':id/chats/:chatId/context')
  async context(@B24User() user: B24UserContext, @Param('id') id: string, @Param('chatId') chatId: string) {
    return this.crm.context(user, await this.chatsService.own(user.portal.id, id), chatId);
  }

  @Put(':id/chats/:chatId/deal')
  async chooseDeal(@B24User() user: B24UserContext, @Param('id') id: string, @Param('chatId') chatId: string, @Body() body: { dealId?: unknown }) {
    const dealId = Number(body?.dealId);
    if (!Number.isSafeInteger(dealId) || dealId < 1) throw new BadRequestException('Укажите сделку');
    const m = await this.chatsService.own(user.portal.id, id);
    const context = await this.crm.choose(user, m, chatId, dealId);
    await this.chatsService.publishChosen(m, chatId);
    return context;
  }

  @Get(':id/chats')
  async chats(@B24User() user: B24UserContext, @Param('id') id: string): Promise<MessengerChatDto[]> {
    return this.chatsService.chats(await this.chatsService.own(user.portal.id, id));
  }

  @Get(':id/chats/:chatId/messages')
  async messages(@B24User() user: B24UserContext, @Param('id') id: string, @Param('chatId') chatId: string, @Query('before') before?: string, @Query('dealId') deal?: string): Promise<MessengerMessageDto[]> {
    const m = await this.chatsService.own(user.portal.id, id);
    const dealId = deal === 'general' ? null : deal === undefined ? undefined : Number(deal);
    if (dealId !== null && dealId !== undefined) {
      const ctx = await this.crm.context(user, m, chatId);
      if (!Number.isSafeInteger(dealId) || !ctx.deals.some(d => d.id === dealId)) throw new ForbiddenException('Сделка недоступна');
    }
    return this.chatsService.messages(m, chatId, before, dealId);
  }

  @Post(':id/send')
  @HttpCode(200)
  async send(@B24User() user: B24UserContext, @Param('id') id: string, @Body() body: MessengerSendDto): Promise<MessengerSendResultDto> {
    return this.chatsService.send(user, await this.chatsService.own(user.portal.id, id), body?.to, body?.text, body?.dealId);
  }

  @Post(':id/messages/:messageId/edit')
  @HttpCode(200)
  async edit(@B24User() user: B24UserContext, @Param('id') id: string, @Param('messageId') messageId: string, @Body() body: { text?: string }): Promise<MessengerMessageDto> {
    return this.chatsService.edit(user, await this.chatsService.own(user.portal.id, id), messageId, String(body?.text ?? ''));
  }

  @Delete(':id/messages/:messageId')
  async deleteMessage(@B24User() user: B24UserContext, @Param('id') id: string, @Param('messageId') messageId: string): Promise<MessengerMessageDto> {
    return this.chatsService.remove(user, await this.chatsService.own(user.portal.id, id), messageId);
  }

  @Get(':id/messages/:messageId/media')
  async media(@B24User() user: B24UserContext, @Param('id') id: string, @Param('messageId') messageId: string, @Res() res: Response): Promise<void> {
    sendFile(res, await this.chatsService.media(await this.chatsService.own(user.portal.id, id), messageId));
  }

  @Post(':id/send-file')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MESSENGER_MAX_FILE_BYTES, files: 1 } }))
  async sendFileTo(@B24User() user: B24UserContext, @Param('id') id: string, @UploadedFile() file: Upload | undefined, @Body() body: { to?: string; text?: string; dealId?: string }): Promise<MessengerSendResultDto> {
    return this.chatsService.sendFile(user, await this.chatsService.own(user.portal.id, id), String(body?.to ?? ''), String(body?.text ?? ''), uploaded(file), body?.dealId === undefined ? undefined : body.dealId === 'general' ? null : Number(body.dealId));
  }

  /** Загрузить историю переписки из мессенджера. */
  @Post(':id/import')
  @HttpCode(200)
  async importHistory(@B24User() user: B24UserContext, @Param('id') id: string): Promise<{ messages: number }> {
    return this.chatsService.importHistory(await this.chatsService.own(user.portal.id, id));
  }

  @Get()
  list(@B24User() user: B24UserContext): Promise<MessengerDto[]> {
    return this.messengers.list(user.portal.id);
  }

  @Post()
  create(@B24User() user: B24UserContext, @Body() body: CreateMessengerDto): Promise<MessengerDto> {
    return this.messengers.create(user.portal.id, user.userId, body);
  }

  @Post(':id/restart')
  @HttpCode(200)
  restart(@B24User() user: B24UserContext, @Param('id') id: string, @Body() body: { auth?: unknown }): Promise<MessengerDto> {
    return this.messengers.restart(user.portal.id, id, body?.auth === 'qr' || body?.auth === 'code' ? body.auth : undefined);
  }

  @Post(':id/stop')
  @HttpCode(200)
  stop(@B24User() user: B24UserContext, @Param('id') id: string): Promise<MessengerDto> {
    return this.messengers.stop(user.portal.id, id);
  }

  @Delete(':id')
  async remove(@B24User() user: B24UserContext, @Param('id') id: string): Promise<{ ok: true }> {
    await this.messengers.remove(user.portal.id, id);
    return { ok: true };
  }

  /** Билет на экран по VNC: интерфейс открывает WebSocket `url` в течение минуты. */
  @Post(':id/vnc-ticket')
  @HttpCode(200)
  async vncTicket(@B24User() user: B24UserContext, @Param('id') id: string): Promise<MessengerVncTicketDto> {
    return { url: `/api/messengers/vnc?ticket=${await this.messengers.vncTicket(user.portal.id, user.userId, id)}` };
  }

  /** Снимок экрана браузера (PNG) — если VNC не открывается. */
  @Get(':id/screenshot')
  async screenshot(@B24User() user: B24UserContext, @Param('id') id: string, @Res() res: Response): Promise<void> {
    const png = await this.messengers.screenshot(user.portal.id, id);
    if (!png) throw new NotFoundException({ code: 'NO_SCREEN', message: 'Экран браузера пока недоступен' });
    res.setHeader('Content-Type', 'image/png');
    res.end(png);
  }
}

/**
 * События сервиса мессенджеров (переписка). Только внутренняя сеть стенда: nginx закрывает путь
 * снаружи; с `MESSENGER_TOKEN` — ещё и по токену.
 */
@Controller('messengers/hook')
export class MessengerHookController {
  constructor(
    private readonly inbox: MessengerInboxService,
    private readonly service: MessengerServiceClient,
  ) {}

  @Post()
  @HttpCode(200)
  async hook(@Headers('x-messenger-token') token: string | undefined, @Body() body: { events?: WireEvent[] }): Promise<{ ok: true }> {
    if (this.service.token && token !== this.service.token) throw new ForbiddenException({ code: 'BAD_TOKEN', message: 'Неверный токен' });
    await this.inbox.apply(Array.isArray(body?.events) ? body.events.slice(0, 500) : []);
    return { ok: true };
  }
}

/**
 * Номера для сотрудников (ADR 0014): только не привязанные к открытой линии — напрямую через шлюз, для
 * групп номера (`openlines.read` — читать, `openlines.send` — писать). Привязанный к линии номер —
 * в «Чатах» (права линии Битрикс24).
 */
@Controller('messengers')
@UseGuards(B24AuthGuard)
export class MessengerUserController {
  constructor(private readonly chatsService: MessengerChatsService, private readonly crm: MessengerCrmService) {}

  @Get('openlines/:chatId/context')
  async lineContext(@B24User() user: B24UserContext, @Param('chatId') id: string) {
    const { m, chatId } = await this.chatsService.fromOpenline(user, Number(id));
    return { ...await this.crm.context(user, m, chatId), messenger: toDto(m, null), chatId };
  }

  @Put('openlines/:chatId/deal')
  async lineDeal(@B24User() user: B24UserContext, @Param('chatId') id: string, @Body() body: { dealId?: unknown }) {
    const { m, chatId } = await this.chatsService.fromOpenline(user, Number(id));
    const { m: permitted } = await this.chatsService.forGroupSend(user, m.id);
    const dealId = Number(body?.dealId);
    if (!Number.isSafeInteger(dealId) || dealId < 1) throw new BadRequestException('Укажите сделку');
    const context = await this.crm.choose(user, permitted, chatId, dealId);
    await this.chatsService.publishChosen(permitted, chatId);
    return context;
  }

  @Get('search')
  search(@B24User() user: B24UserContext, @Query('phone') phone: string, @Query('login') login?: string) {
    return this.chatsService.search(user, phone, login);
  }


  @Get()
  async list(@B24User() user: B24UserContext): Promise<MessengerDto[]> {
    return (await this.chatsService.available(user)).map((m) => toDto(m, null));
  }

  @Get(':id/chats/:chatId/context')
  async context(@B24User() user: B24UserContext, @Param('id') id: string, @Param('chatId') chatId: string) {
    return this.crm.context(user, (await this.chatsService.forUser(user, id, false, chatId)).m, chatId);
  }

  @Put(':id/chats/:chatId/deal')
  async chooseDeal(@B24User() user: B24UserContext, @Param('id') id: string, @Param('chatId') chatId: string, @Body() body: { dealId?: unknown }) {
    const dealId = Number(body?.dealId);
    if (!Number.isSafeInteger(dealId) || dealId < 1) throw new BadRequestException('Укажите сделку');
    const m = (await this.chatsService.forUser(user, id, true, chatId)).m;
    const context = await this.crm.choose(user, m, chatId, dealId);
    await this.chatsService.publishChosen(m, chatId);
    return context;
  }

  @Get(':id/chats')
  async chats(@B24User() user: B24UserContext, @Param('id') id: string): Promise<MessengerChatDto[]> {
    return this.chatsService.chatsForUser(user, id);
  }

  @Get(':id/chats/:chatId/messages')
  async messages(@B24User() user: B24UserContext, @Param('id') id: string, @Param('chatId') chatId: string, @Query('before') before?: string, @Query('dealId') deal?: string): Promise<MessengerMessageDto[]> {
    const m = (await this.chatsService.forUser(user, id, false, chatId)).m;
    const dealId = deal === 'general' ? null : deal === undefined ? undefined : Number(deal);
    if (dealId !== null && dealId !== undefined) {
      const ctx = await this.crm.context(user, m, chatId);
      if (!Number.isSafeInteger(dealId) || !ctx.deals.some(d => d.id === dealId)) throw new ForbiddenException('Сделка недоступна');
    }
    return this.chatsService.messages(m, chatId, before, dealId);
  }

  @Post(':id/send')
  @HttpCode(200)
  async send(@B24User() user: B24UserContext, @Param('id') id: string, @Body() body: MessengerSendDto): Promise<MessengerSendResultDto> {
    return this.chatsService.send(user, (await this.chatsService.forUser(user, id, true, body?.to)).m, body?.to, body?.text, body?.dealId);
  }

  @Post(':id/messages/:messageId/edit')
  @HttpCode(200)
  async edit(@B24User() user: B24UserContext, @Param('id') id: string, @Param('messageId') messageId: string, @Body() body: { text?: string }): Promise<MessengerMessageDto> {
    return this.chatsService.edit(user, (await this.chatsService.forMessage(user, id, messageId, true)).m, messageId, String(body?.text ?? ''));
  }

  @Delete(':id/messages/:messageId')
  async remove(@B24User() user: B24UserContext, @Param('id') id: string, @Param('messageId') messageId: string): Promise<MessengerMessageDto> {
    return this.chatsService.remove(user, (await this.chatsService.forMessage(user, id, messageId, true)).m, messageId);
  }

  @Get(':id/messages/:messageId/media')
  async media(@B24User() user: B24UserContext, @Param('id') id: string, @Param('messageId') messageId: string, @Res() res: Response): Promise<void> {
    sendFile(res, await this.chatsService.media((await this.chatsService.forMessage(user, id, messageId, false)).m, messageId));
  }

  @Post(':id/send-file')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MESSENGER_MAX_FILE_BYTES, files: 1 } }))
  async sendFileTo(@B24User() user: B24UserContext, @Param('id') id: string, @UploadedFile() file: Upload | undefined, @Body() body: { to?: string; text?: string; dealId?: string }): Promise<MessengerSendResultDto> {
    return this.chatsService.sendFile(user, (await this.chatsService.forUser(user, id, true, String(body?.to ?? ''))).m, String(body?.to ?? ''), String(body?.text ?? ''), uploaded(file), body?.dealId === undefined ? undefined : body.dealId === 'general' ? null : Number(body.dealId));
  }
}

/**
 * Вложение по подписанной ссылке — для своей открытой линии (Битрикс24 скачивает файл сам, без входа
 * в приложение). Без верной подписи или после срока — 404.
 */
@Controller('messengers/files')
export class MessengerPublicFilesController {
  constructor(
    private readonly links: MediaLinks,
    private readonly service: MessengerServiceClient,
  ) {}

  @Get(':messengerId/:fileId')
  async file(@Param('messengerId') messengerId: string, @Param('fileId') fileId: string, @Query('exp') exp: string, @Query('sig') sig: string, @Res() res: Response): Promise<void> {
    if (!/^[0-9a-f]{40}$/.test(fileId) || !this.links.valid(messengerId, fileId, exp, sig)) throw new NotFoundException();
    const file = await this.service.readMedia(messengerId, fileId);
    if (!file) throw new NotFoundException();
    sendFile(res, { ...file, name: 'file' });
  }
}

type Upload = { originalname: string; mimetype: string; size: number; buffer: Buffer };

function uploaded(file: Upload | undefined): { mime: string; name: string; data: Buffer } {
  if (!file?.buffer?.length) throw new BadRequestException({ code: 'NO_FILE', message: 'Нет файла' });
  // multer отдаёт имя в latin1 — возвращаем UTF-8 (русские имена файлов).
  return { mime: file.mimetype || 'application/octet-stream', name: Buffer.from(file.originalname, 'latin1').toString('utf8').slice(0, 200), data: file.buffer };
}

function sendFile(res: Response, f: { data: Buffer; mime: string; name: string }): void {
  res.setHeader('Content-Type', f.mime);
  const inline = /^(image\/(jpeg|png|webp|gif|avif)|video\/(mp4|webm|ogg)|audio\/)/i.test(f.mime);
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.end(f.data);
}
