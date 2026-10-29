import { Body, Controller, ForbiddenException, Get, HttpCode, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import type { ServiceChatDto, ServiceChatMessageDto } from '@btx24/shared';
import { AccessService } from '../access/access.service.js';
import { B24AuthGuard, B24User } from '../bitrix24/auth/b24-auth.guard.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { ServiceChatService } from './service-chat.service.js';

/** Служебный чат сделки (встройка сделки): читать — `openlines.read`, создавать и писать — `openlines.send`. */
@Controller('deals/:dealId/service-chat')
@UseGuards(B24AuthGuard)
export class ServiceChatController {
  constructor(
    private readonly chats: ServiceChatService,
    private readonly access: AccessService,
  ) {}

  @Get()
  async get(@B24User() user: B24UserContext, @Param('dealId', ParseIntPipe) dealId: number): Promise<ServiceChatDto> {
    await this.require(user, 'openlines.read');
    return this.chats.get(user, dealId);
  }

  @Post()
  @HttpCode(200)
  async create(@B24User() user: B24UserContext, @Param('dealId', ParseIntPipe) dealId: number): Promise<ServiceChatDto> {
    await this.require(user, 'openlines.send');
    return this.chats.create(user, dealId);
  }

  @Post('messages')
  async post(@B24User() user: B24UserContext, @Param('dealId', ParseIntPipe) dealId: number, @Body() body: { text?: unknown }): Promise<ServiceChatMessageDto> {
    await this.require(user, 'openlines.send');
    return this.chats.post(user, dealId, body?.text);
  }

  private async require(user: B24UserContext, permission: 'openlines.read' | 'openlines.send'): Promise<void> {
    const a = await this.access.resolve(user);
    if (!a.isAppAdmin && this.access.pick(a, undefined, permission) === null)
      throw new ForbiddenException({ code: 'NO_PERMISSION', message: permission === 'openlines.send' ? 'Нет права писать в чаты' : 'Нет доступа к чатам' });
  }
}
