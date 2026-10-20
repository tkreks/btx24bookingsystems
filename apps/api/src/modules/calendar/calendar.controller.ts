import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { isIsoDate, todayIn, type CalendarDay } from '@btx24/shared';
import { B24AuthGuard, B24User } from '../bitrix24/auth/b24-auth.guard.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { CalendarService } from './calendar.service.js';

@Controller('calendar')
@UseGuards(B24AuthGuard)
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  /** `GET /api/calendar?date=YYYY-MM-DD` (по умолчанию — сегодня в поясе портала). */
  @Get()
  day(@B24User() user: B24UserContext, @Query('date') date?: string): Promise<CalendarDay> {
    const day = date ?? todayIn(user.portal.timezone);
    if (!isIsoDate(day)) throw new BadRequestException({ code: 'INVALID_DATE', message: 'date должен быть в формате YYYY-MM-DD' });
    return this.calendar.day(user, day);
  }
}
