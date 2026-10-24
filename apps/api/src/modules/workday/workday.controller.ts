import { Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import type { WorkdayDto } from '@btx24/shared';
import { B24AuthGuard, B24User } from '../bitrix24/auth/b24-auth.guard.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { OnShiftService } from './on-shift.service.js';
import { WorkdayService } from './workday.service.js';

/** Свой рабочий день: статус и «начать / перерыв / завершить» (кнопка в правом верхнем углу). */
@Controller('workday')
@UseGuards(B24AuthGuard)
export class WorkdayController {
  constructor(private readonly workday: WorkdayService, private readonly onShift: OnShiftService) {}

  @Get()
  status(@B24User() user: B24UserContext): Promise<WorkdayDto> {
    return this.workday.status(user);
  }

  @Get('on-shift')
  list(@B24User() user: B24UserContext) { return this.onShift.list(user); }

  @Post(':action')
  @HttpCode(200)
  act(@B24User() user: B24UserContext, @Param('action') action: string): Promise<WorkdayDto> {
    return this.workday.act(user, action);
  }
}
