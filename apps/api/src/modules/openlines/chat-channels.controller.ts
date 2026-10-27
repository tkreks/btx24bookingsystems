import { BadRequestException, Body, Controller, Get, Param, ParseIntPipe, Put, UseGuards } from '@nestjs/common';
import type { ChatChannelsAdminDto } from '@btx24/shared';
import { z } from 'zod';
import { AppAdminGuard } from '../access/app-admin.guard.js';
import { B24AuthGuard, B24User } from '../bitrix24/auth/b24-auth.guard.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { PortalService } from '../bitrix24/portals/portal.service.js';
import { ConversationsService } from './conversations.service.js';

const body = z.object({ channel: z.string().regex(/^[a-z]+:[0-9a-zA-Z_.@-]{1,60}$/).nullable() }).strict();

/**
 * ⚙ → «Мессенджеры» → «Каналы линий» (администраторы приложения, ADR 0017): какой наш номер у линии
 * открытых линий. Чаты клиента в линиях одного канала показываются одной перепиской.
 */
@Controller('admin/chat-channels')
@UseGuards(B24AuthGuard, AppAdminGuard)
export class ChatChannelsAdminController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly portals: PortalService,
  ) {}

  @Get()
  list(@B24User() user: B24UserContext): Promise<ChatChannelsAdminDto> {
    return this.conversations.channelsAdmin(user.portal.id);
  }

  @Put(':lineId')
  set(@B24User() user: B24UserContext, @Param('lineId', ParseIntPipe) lineId: number, @Body() raw: unknown): Promise<ChatChannelsAdminDto> {
    const parsed = body.safeParse(raw);
    if (!parsed.success) throw new BadRequestException({ code: 'INVALID_CHANNEL', message: 'Ожидается { channel: "<вид>:<номер>" | null }' });
    // Список линий портала — токеном приложения (как у worker'а); права на изменение даёт AppAdminGuard.
    return this.conversations.setLineChannel(user.portal, lineId, parsed.data.channel, this.portals.clientFor(user.portal));
  }
}
