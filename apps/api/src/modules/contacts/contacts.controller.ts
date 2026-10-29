import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { B24AuthGuard, B24User } from '../bitrix24/auth/b24-auth.guard.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { AppAdminGuard } from '../access/app-admin.guard.js';
import { ContactAlertsService } from './contact-alerts.service.js';
const schema = z.object({ status: z.enum(['new', 'viewed', 'resolved', 'ignored']) }).strict();
const bulk = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(200), status: z.enum(['new', 'viewed', 'resolved', 'ignored']) }).strict();
@Controller('contact-alerts')
@UseGuards(B24AuthGuard, AppAdminGuard)
export class ContactAlertsController {
  constructor(private readonly alerts: ContactAlertsService) {}
  @Get()
  list(@B24User() user: B24UserContext, @Query() query: Record<string, unknown>) { return this.alerts.list(user, query); }
  @Post('bulk')
  @HttpCode(200)
  setStatusMany(@B24User() user: B24UserContext, @Body() body: unknown) {
    const parsed = bulk.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Укажите уведомления (до 200) и статус');
    return this.alerts.setStatusMany(user, parsed.data.ids, parsed.data.status);
  }
  @Put(':id')
  setStatus(@B24User() user: B24UserContext, @Param('id') id: string, @Body() body: unknown) {
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Укажите статус уведомления');
    return this.alerts.setStatus(user, id, parsed.data.status);
  }
}
