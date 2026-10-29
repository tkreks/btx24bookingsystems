import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ViewerDayDto, ViewerProductsDto, ViewerSessionDto } from '@btx24/shared';
import { STANDALONE_HEADER } from '../bitrix24/auth/user-context.js';
import { AuthError } from '../bitrix24/auth/user-token.verifier.js';
import { readCookie } from '../bitrix24/auth/web-session.service.js';
import { EXTERNAL_COOKIE, EXTERNAL_TTL_MS, ExternalAuthService, type ExternalUserContext } from './external-auth.service.js';
import { ExternalAuthGuard, ExternalUser } from './external-auth.guard.js';
import { ViewerService } from './viewer.service.js';

const COOKIE = { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/' };
const loginSchema = z.object({ login: z.string().trim().min(1).max(100), password: z.string().min(1).max(128), domain: z.string().max(255).optional() }).strict();
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Вход по логину и паролю и экран «Бронирования» внешнего пользователя (ADR 0021). */
@Controller('external')
export class ExternalController {
  constructor(
    private readonly auth: ExternalAuthService,
    private readonly viewer: ViewerService,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<{ ok: true }> {
    // Заголовок — как у остальных запросов вне портала: чужой сайт не войдёт под чужим паролем от имени браузера.
    if (req.headers[STANDALONE_HEADER] !== '1') throw new AuthError('UNAUTHORIZED', 'Откройте страницу входа приложения');
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ code: 'INVALID_LOGIN', message: 'Укажите логин и пароль' });
    const { secret } = await this.auth.login(parsed.data, req.ip ?? 'unknown');
    res.cookie(EXTERNAL_COOKIE, secret, { ...COOKIE, maxAge: EXTERNAL_TTL_MS });
    return { ok: true };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    if (req.headers[STANDALONE_HEADER] !== '1') return;
    const secret = readCookie(req.headers.cookie, EXTERNAL_COOKIE);
    if (secret) await this.auth.logout(secret);
    res.clearCookie(EXTERNAL_COOKIE, COOKIE);
  }

  @Get('session')
  @UseGuards(ExternalAuthGuard)
  session(@ExternalUser() ctx: ExternalUserContext): Promise<ViewerSessionDto> {
    return this.viewer.session(ctx);
  }

  @Get('day')
  @UseGuards(ExternalAuthGuard)
  day(@ExternalUser() ctx: ExternalUserContext, @Query('date') date: unknown, @Query('groupId') groupId: unknown): Promise<ViewerDayDto> {
    if (typeof date !== 'string' || !DATE.test(date)) throw new BadRequestException({ code: 'INVALID_DATE', message: 'Укажите дату ГГГГ-ММ-ДД' });
    return this.viewer.day(ctx, date, typeof groupId === 'string' ? groupId.slice(0, 64) : '');
  }

  @Get('bookings/:bookingId/products')
  @UseGuards(ExternalAuthGuard)
  products(@ExternalUser() ctx: ExternalUserContext, @Param('bookingId', ParseIntPipe) bookingId: number): Promise<ViewerProductsDto> {
    return this.viewer.productsOf(ctx, bookingId);
  }
}
