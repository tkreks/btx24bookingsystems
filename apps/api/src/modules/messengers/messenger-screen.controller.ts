import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MESSENGER_ERROR_STATES, MESSENGER_MAX_FILE_BYTES, MESSENGER_STATE_LABELS, type MessengerScreenFilesDto, type MessengerStatusDto, type MessengerVncTicketDto } from '@btx24/shared';
import type { Response } from 'express';
import { B24AuthGuard, B24User } from '../bitrix24/auth/b24-auth.guard.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { MessengerChatsService } from './messenger-chats.service.js';
import { MessengerServiceClient } from './messenger-service.client.js';
import { MessengersService } from './messengers.service.js';

const FILE_ID_RE = /^[0-9a-f]{24}$/;

/**
 * Блок дашборда «Мессенджеры»: состояние номеров групп сотрудника (`openlines.read`) и экран номера по
 * VNC с файлами для отправки (право писать с номера — `openlines.send`; администратор — все номера).
 * Файлы для экрана хранит сервис messenger час.
 */
@Controller('messengers')
@UseGuards(B24AuthGuard)
export class MessengerScreenController {
  constructor(
    private readonly chats: MessengerChatsService,
    private readonly messengers: MessengersService,
    private readonly service: MessengerServiceClient,
  ) {}

  /** Все номера групп сотрудника в любом состоянии; у номеров с ошибкой — описание ошибки. */
  @Get('status')
  async status(@B24User() user: B24UserContext): Promise<MessengerStatusDto[]> {
    const rows = await this.chats.available(user);
    if (!rows.length) return [];
    const [live, sendable] = await Promise.all([this.messengers.list(user.portal.id), this.chats.sendable(user, rows)]);
    const visible = new Set(rows.map((r) => r.id));
    return live
      .filter((m) => visible.has(m.id))
      .map((m) => ({
        id: m.id,
        kind: m.kind,
        phone: m.phone,
        title: m.title,
        state: m.state,
        error: MESSENGER_ERROR_STATES.includes(m.state) ? m.error || MESSENGER_STATE_LABELS[m.state] : null,
        canScreen: sendable.has(m.id),
      }));
  }

  @Post(':id/vnc-ticket')
  @HttpCode(200)
  async vncTicket(@B24User() user: B24UserContext, @Param('id') id: string): Promise<MessengerVncTicketDto> {
    await this.chats.forUser(user, id, true);
    return { url: `/api/messengers/vnc?ticket=${await this.messengers.vncTicket(user.portal.id, user.userId, id)}` };
  }

  @Get(':id/screenshot')
  async screenshot(@B24User() user: B24UserContext, @Param('id') id: string, @Res() res: Response): Promise<void> {
    await this.chats.forUser(user, id, true);
    const png = await this.messengers.screenshot(user.portal.id, id);
    if (!png) throw new NotFoundException({ code: 'NO_SCREEN', message: 'Экран браузера пока недоступен' });
    res.setHeader('Content-Type', 'image/png');
    res.end(png);
  }

  @Get(':id/screen-files')
  async files(@B24User() user: B24UserContext, @Param('id') id: string): Promise<MessengerScreenFilesDto> {
    await this.chats.forUser(user, id, true);
    return this.service.screenFiles(id);
  }

  @Post(':id/screen-files')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MESSENGER_MAX_FILE_BYTES, files: 1 } }))
  async upload(@B24User() user: B24UserContext, @Param('id') id: string, @UploadedFile() file: { originalname: string; mimetype: string; buffer: Buffer } | undefined): Promise<MessengerScreenFilesDto> {
    await this.chats.forUser(user, id, true);
    if (!file?.buffer?.length) throw new BadRequestException({ code: 'NO_FILE', message: 'Нет файла' });
    // multer отдаёт имя в latin1 — возвращаем UTF-8 (русские имена файлов).
    const name = Buffer.from(file.originalname, 'latin1').toString('utf8').slice(0, 150);
    return this.service.uploadScreenFile(id, { mime: file.mimetype || 'application/octet-stream', name, data: file.buffer });
  }

  @Delete(':id/screen-files/:fileId')
  async remove(@B24User() user: B24UserContext, @Param('id') id: string, @Param('fileId') fileId: string): Promise<MessengerScreenFilesDto> {
    await this.chats.forUser(user, id, true);
    if (!FILE_ID_RE.test(fileId)) throw new NotFoundException();
    return this.service.removeScreenFile(id, fileId);
  }

  /** Подставить файл в следующее окно выбора файла на экране (сотрудник нажимает 📎 в мессенджере). */
  @Post(':id/screen-files/:fileId/attach')
  @HttpCode(200)
  async attach(@B24User() user: B24UserContext, @Param('id') id: string, @Param('fileId') fileId: string): Promise<MessengerScreenFilesDto> {
    await this.chats.forUser(user, id, true);
    if (!FILE_ID_RE.test(fileId)) throw new NotFoundException();
    return this.service.offerScreenFile(id, fileId);
  }

  /**
   * Ctrl+V / перетаскивание на экран (решение владельца 2026-10-27): текст вводится в поле под курсором,
   * файл загружается в файлы экрана и «вставляется» в открытый чат — как вставка на своём компьютере.
   */
  @Post(':id/screen-paste')
  @HttpCode(200)
  async pasteText(@B24User() user: B24UserContext, @Param('id') id: string, @Body() body: unknown): Promise<{ ok: boolean }> {
    await this.chats.forUser(user, id, true);
    const text = (body as { text?: unknown } | null)?.text;
    if (typeof text !== 'string' || !text || text.length > 20_000) throw new BadRequestException({ code: 'NO_TEXT', message: 'Нет текста (до 20 000 знаков)' });
    return this.service.screenPaste(id, { text });
  }

  @Post(':id/screen-paste-file')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MESSENGER_MAX_FILE_BYTES, files: 1 } }))
  async pasteFile(@B24User() user: B24UserContext, @Param('id') id: string, @UploadedFile() file: { originalname: string; mimetype: string; buffer: Buffer } | undefined): Promise<{ ok: boolean }> {
    await this.chats.forUser(user, id, true);
    if (!file?.buffer?.length) throw new BadRequestException({ code: 'NO_FILE', message: 'Нет файла' });
    const before = new Set((await this.service.screenFiles(id)).files.map((f) => f.id));
    const name = Buffer.from(file.originalname, 'latin1').toString('utf8').slice(0, 150);
    const after = await this.service.uploadScreenFile(id, { mime: file.mimetype || 'application/octet-stream', name, data: file.buffer });
    const added = after.files.find((f) => !before.has(f.id));
    if (!added) throw new BadRequestException({ code: 'NO_FILE', message: 'Файл не сохранился' });
    return this.service.screenPaste(id, { fileId: added.id });
  }

  @Delete(':id/screen-files')
  async cancel(@B24User() user: B24UserContext, @Param('id') id: string): Promise<MessengerScreenFilesDto> {
    await this.chats.forUser(user, id, true);
    return this.service.cancelScreenOffer(id);
  }
}
