import { BadRequestException, Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { MERGE_MAX_CONTACTS } from '@btx24/shared';
import { B24AuthGuard, B24User } from '../bitrix24/auth/b24-auth.guard.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { PermanentAdminGuard } from '../access/permanent-admin.guard.js';
import { ContactDuplicatesService } from './contact-duplicates.service.js';
import { ContactMergeService } from './contact-merge.service.js';
import { DEFAULT_LIMIT, MAX_LIMIT } from './contact-duplicates.index.js';

const listQuery = z.object({
  by: z.enum(['all', 'phone', 'email', 'name', 'messenger']).default('all'),
  q: z.string().max(100).optional(),
  cursor: z.string().regex(/^\d{1,7}$/).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});
const compareQuery = z.object({ ids: z.string().regex(/^\d{1,12}(,\d{1,12}){1,20}$/) });

/** «Дубли контактов» (ADR 0022): поиск, сравнение и объединение — только постоянные администраторы приложения. */
@Controller('contacts/duplicates')
@UseGuards(B24AuthGuard, PermanentAdminGuard)
export class ContactDuplicatesController {
  constructor(
    private readonly duplicates: ContactDuplicatesService,
    private readonly merger: ContactMergeService,
  ) {}

  @Get()
  list(@B24User() user: B24UserContext, @Query() query: Record<string, unknown>) {
    const p = listQuery.safeParse(query);
    if (!p.success) throw new BadRequestException({ code: 'INVALID_QUERY', message: 'Неверные параметры поиска дублей' });
    return this.duplicates.list(user, p.data);
  }

  @Get('compare')
  compare(@B24User() user: B24UserContext, @Query() query: Record<string, unknown>) {
    const p = compareQuery.safeParse(query);
    if (!p.success) throw new BadRequestException({ code: 'INVALID_CONTACT_IDS', message: `Выберите от 2 до ${MERGE_MAX_CONTACTS} контактов` });
    return this.duplicates.compare(user, p.data.ids.split(',').map(Number));
  }

  @Post('merge')
  @HttpCode(200)
  merge(@B24User() user: B24UserContext, @Body() body: unknown) {
    return this.merger.merge(user, body);
  }
}
