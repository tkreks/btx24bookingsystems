import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { ActiveCallDto, CallCardDto } from '@btx24/shared';
import { B24AuthGuard, B24User } from '../bitrix24/auth/b24-auth.guard.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { CallCardService } from './call-card.service.js';

/** Звонки клиентов: карточка (окно звонка Битрикс24 и всплывающая в приложении) и текущие звонки сотрудника. */
@Controller('calls')
@UseGuards(B24AuthGuard)
export class CallsController {
  constructor(private readonly cards: CallCardService) {}

  @Get('active')
  active(@B24User() user: B24UserContext): Promise<ActiveCallDto[]> {
    return this.cards.active(user);
  }

  @Get('card')
  card(@B24User() user: B24UserContext, @Query() query: Record<string, unknown>): Promise<CallCardDto> {
    return this.cards.card(user, query);
  }
}
