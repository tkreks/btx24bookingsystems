import { Controller, ForbiddenException, Get, Post, UseGuards } from '@nestjs/common';
import { B24AuthGuard, B24User } from '../auth/b24-auth.guard.js';
import type { B24UserContext } from '../auth/user-context.js';
import { PlacementsService } from './placements.service.js';

/** Управление встройками — только администратор портала (действует его токеном). */
@Controller('admin/placements')
@UseGuards(B24AuthGuard)
export class PlacementsController {
  constructor(private readonly placements: PlacementsService) {}

  @Get()
  status(@B24User() user: B24UserContext) {
    this.requireAdmin(user);
    return this.placements.status(user.client);
  }

  @Post('sync')
  sync(@B24User() user: B24UserContext) {
    this.requireAdmin(user);
    return this.placements.sync(user.client);
  }

  private requireAdmin(user: B24UserContext) {
    if (!user.isAdmin) throw new ForbiddenException({ code: 'NOT_ADMIN', message: 'Только для администратора Битрикс24' });
  }
}
