import { Controller, Get, HttpCode, HttpException, Logger, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { STANDALONE_HEADER } from '../bitrix24/auth/user-context.js';
import { UserTokenVerifier } from '../bitrix24/auth/user-token.verifier.js';
import { SESSION_COOKIE, SESSION_TTL_MS, STATE_COOKIE, WebSessionService, readCookie } from '../bitrix24/auth/web-session.service.js';
import { ActionLogService, userActor } from '../audit/action-log.service.js';
import { AccessService } from './access.service.js';

const COOKIE = { httpOnly: true, secure: true, sameSite: 'lax' as const };
const STATE_TTL_MS = 10 * 60_000;
const logger = new Logger('WebLoginController');

/**
 * Вход в приложение вне портала через аккаунт Битрикс24 (OAuth, `WebSessionService`):
 * `/api/auth/login` → страница входа портала → `/api/auth/callback` → cookie сессии → `/`.
 * Войти могут только те, кому открыт доступ к приложению (`AccessService.canEnter`).
 */
@Controller('auth')
export class WebLoginController {
  constructor(
    private readonly sessions: WebSessionService,
    private readonly verifier: UserTokenVerifier,
    private readonly access: AccessService,
    private readonly actionLog: ActionLogService,
  ) {}

  @Get('login')
  async login(@Query('domain') domain: unknown, @Req() req: Request, @Res() res: Response): Promise<void> {
    try {
      const { url, state } = await this.sessions.start(typeof domain === 'string' ? domain : undefined, this.sessions.redirectUri(origin(req)));
      res.cookie(STATE_COOKIE, state, { ...COOKIE, path: '/api/auth', maxAge: STATE_TTL_MS });
      res.redirect(302, url);
    } catch (err) {
      back(res, err);
    }
  }

  @Get('callback')
  async callback(@Query() q: Record<string, unknown>, @Req() req: Request, @Res() res: Response): Promise<void> {
    res.clearCookie(STATE_COOKIE, { ...COOKIE, path: '/api/auth' });
    try {
      const { portal, tokens, oauthHost } = await this.sessions.finish(q, readCookie(req.headers.cookie, STATE_COOKIE));
      const user = await this.verifier.verify(portal.memberId, tokens.accessToken);
      if (!(await this.access.canEnter(user))) {
        back(res, 'Доступ к приложению ограничен. Обратитесь к администратору портала.');
        return;
      }
      const secret = await this.sessions.create(portal, tokens, oauthHost, { id: user.userId, name: user.userName });
      await this.actionLog.log(portal.id, userActor(user), { action: 'app.login', summary: 'Вход в приложение через Битрикс24 (вне портала)', via: 'web' });
      res.cookie(SESSION_COOKIE, secret, { ...COOKIE, path: '/', maxAge: SESSION_TTL_MS });
      res.redirect(302, '/');
    } catch (err) {
      back(res, err);
    }
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    // Заголовок — как у остальных запросов вне портала: чужой сайт не разлогинит сотрудника.
    if (req.headers[STANDALONE_HEADER] !== '1') return;
    const secret = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (secret) await this.sessions.destroy(secret);
    res.clearCookie(SESSION_COOKIE, { ...COOKIE, path: '/' });
  }
}

function origin(req: Request): string {
  return `${req.protocol}://${req.get('host') ?? 'localhost'}`;
}

/** Ошибка входа — обратно на страницу входа с текстом (наши понятные ошибки; прочее — общим текстом). */
function back(res: Response, err: unknown): void {
  const r = err instanceof HttpException ? (err.getResponse() as { message?: unknown }) : undefined;
  const message = typeof err === 'string' ? err : typeof r?.message === 'string' ? r.message : 'Не удалось войти через Битрикс24 — попробуйте ещё раз';
  if (typeof err !== 'string' && !r) logger.warn(`web login failed: ${err instanceof Error ? `${(err as { code?: string }).code ?? err.name}: ${err.message}` : String(err)}`);
  res.redirect(302, `/?login_error=${encodeURIComponent(message)}`);
}
