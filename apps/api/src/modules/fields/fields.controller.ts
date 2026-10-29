import { BadRequestException, Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { B24AuthGuard, B24User } from '../bitrix24/auth/b24-auth.guard.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { AppAdminGuard } from '../access/app-admin.guard.js';
import { PermanentAdminGuard } from '../access/permanent-admin.guard.js';
import { FieldsService } from './fields.service.js';
const code = z.string().regex(/^UF_CRM_[A-Z0-9_]{1,60}$/);
const schema = z.object({ deal: z.record(z.string().max(60), code), contact: z.object({ telegram: code.optional(), whatsapp: code.optional(), max: code.optional(), whatsappLid: code.optional(), telegramLogin: code.optional(), maxLogin: code.optional() }).strict(), systemUserIds: z.array(z.number().int().positive()).max(50).optional() }).strict();
@Controller('admin/fields')
@UseGuards(B24AuthGuard, AppAdminGuard)
export class FieldsController {
  constructor(private readonly fields: FieldsService) {}
  @Get()
  get(@B24User() user: B24UserContext) { return this.fields.get(user); }
  @Post(':entity/:key/create')
  @UseGuards(PermanentAdminGuard)
  create(@B24User() user: B24UserContext, @Param('entity') entity: string, @Param('key') key: string) {
    if (entity !== 'deal' && entity !== 'contact') throw new BadRequestException('Неизвестная сущность');
    return this.fields.create(user, entity, key);
  }
  @Put()
  @UseGuards(PermanentAdminGuard)
  save(@B24User() user: B24UserContext, @Body() body: unknown) {
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ code: 'INVALID_FIELD_MAP', message: 'Ожидаются сопоставления полей сделки и контакта' });
    return this.fields.save(user, parsed.data);
  }
}
