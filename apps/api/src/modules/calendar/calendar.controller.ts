import { BadRequestException, Controller, ForbiddenException, Get, Query, UseGuards } from '@nestjs/common';
import { addMonths, isIsoDate, TIMELINE_MAX_MONTHS, todayIn, type CalendarDay, type CalendarRangeDto, type GroupOptionsDto } from '@btx24/shared';
import { AccessService } from '../access/access.service.js';
import { B24AuthGuard, B24User } from '../bitrix24/auth/b24-auth.guard.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { CalendarService } from './calendar.service.js';

@Controller('calendar')
@UseGuards(B24AuthGuard)
export class CalendarController {
  constructor(
    private readonly calendar: CalendarService,
    private readonly access: AccessService,
  ) {}

  /**
   * `GET /api/calendar/range?groupId=…&from=YYYY-MM-DD&to=YYYY-MM-DD` — шкала броней за период (до
   * `TIMELINE_MAX_MONTHS` месяцев) из журнала приложения; права — как у дня.
   */
  @Get('range')
  async range(
    @B24User() user: B24UserContext,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('groupId') groupId?: string,
  ): Promise<CalendarRangeDto> {
    if (!from || !to || !isIsoDate(from) || !isIsoDate(to) || to < from)
      throw new BadRequestException({ code: 'INVALID_RANGE', message: 'from и to — даты YYYY-MM-DD, to не раньше from' });
    if (to >= addMonths(from, TIMELINE_MAX_MONTHS))
      throw new BadRequestException({ code: 'RANGE_TOO_LONG', message: `Период шкалы — не больше ${TIMELINE_MAX_MONTHS} месяцев` });
    const access = await this.access.resolve(user);
    const group = this.access.pick(access, groupId, 'calendar.view');
    if (!group) {
      if (access.isAppAdmin && !groupId && access.groups.length === 0) return this.calendar.range(user, from, to);
      throw new ForbiddenException({ code: 'NO_GROUP_ACCESS', message: groupId ? 'Нет доступа к этой группе' : 'Вы не состоите ни в одной группе приложения — обратитесь к администратору' });
    }
    return this.calendar.range(user, from, to, {
      resourceIds: group.group.resourceIds,
      withDetails: group.permissions.includes('booking.details'),
      techWindowMinutes: group.group.techWindowMinutes,
    });
  }

  /**
   * `GET /api/calendar?date=YYYY-MM-DD&groupId=…` — день по ресурсам группы (по умолчанию —
   * первая доступная группа). Администратор приложения без групп видит все ресурсы портала.
   */
  @Get()
  async day(
    @B24User() user: B24UserContext,
    @Query('date') date?: string,
    @Query('groupId') groupId?: string,
  ): Promise<CalendarDay> {
    const day = date ?? todayIn(user.portal.timezone);
    if (!isIsoDate(day))
      throw new BadRequestException({ code: 'INVALID_DATE', message: 'date должен быть в формате YYYY-MM-DD' });

    const access = await this.access.resolve(user);
    const group = this.access.pick(access, groupId, 'calendar.view');
    if (!group) {
      if (access.isAppAdmin && !groupId && access.groups.length === 0) return this.calendar.day(user, day);
      throw new ForbiddenException({
        code: 'NO_GROUP_ACCESS',
        message: groupId
          ? 'Нет доступа к этой группе'
          : 'Вы не состоите ни в одной группе приложения — обратитесь к администратору',
      });
    }
    const options = group.group.options as GroupOptionsDto | null;
    return this.calendar.day(user, day, {
      resourceIds: group.group.resourceIds,
      withDetails: group.permissions.includes('booking.details'),
      techWindowMinutes: group.group.techWindowMinutes,
      dealFields: options?.dealFields ?? [],
    });
  }
}
