import { Body, Controller, Get, HttpCode, Logger, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PortalService } from '../portals/portal.service.js';
import { Bitrix24Error } from '../rest/errors.js';
import { installPage } from './install-page.js';
import { InstallService, normalizeInstallRequest, type InstallEvent, type InstallRequest } from './install.service.js';

const presentKeys = (o: object) => Object.keys(o).sort().join(',');

@Controller('b24')
export class InstallController {
  private readonly logger = new Logger(InstallController.name);

  constructor(
    private readonly install: InstallService,
    private readonly portals: PortalService,
  ) {}

  @Get('install')
  page(@Res() res: Response) {
    res.status(400).type('html').send(installPage(false, 'Откройте установку из Битрикс24.'));
  }

  /**
   * URL установки локального приложения: `<APP_BASE_URL>/api/b24/install`. Принимает и форму мастера
   * установки (ответ — HTML с BX24.installFinish), и событие ONAPPINSTALL при включённой опции
   * «Приложение само завершает установку» (ответ — JSON).
   */
  @Post('install')
  @HttpCode(200)
  async handle(@Query() query: InstallRequest, @Body() body: InstallRequest & InstallEvent, @Res() res: Response) {
    const event = String(body?.event ?? '').toUpperCase();
    const isEvent = event === 'ONAPPINSTALL';
    // Битрикс24 сам привязывает к адресу установки и другие события (ONAPPUSERREADY) — им здесь нечего делать.
    if (event && !isEvent) {
      res.json({ ok: true, ignored: event });
      return;
    }
    try {
      const { domain } = await this.install.install(normalizeInstallRequest({ ...query, ...body }));
      if (isEvent) res.json({ ok: true });
      else res.type('html').send(installPage(true, `Приложение установлено на портал ${domain}.`));
    } catch (err) {
      const known = err instanceof Bitrix24Error;
      // Сообщения Bitrix24Error формируем сами или берём error_description — секретов в них нет.
      this.logger.warn(`install failed: ${known ? `${err.code}: ${err.message}` : (err as Error).message} (fields: ${presentKeys({ ...query, ...body })})`);
      const status = known && err.code === 'NOT_ADMIN' ? 403 : known ? 400 : 500;
      if (isEvent) {
        res.status(status).json({ ok: false });
        return;
      }
      const message = known && err.code === 'NOT_ADMIN' ? 'Установить приложение может только администратор Битрикс24.' : 'Не удалось установить приложение. Подробности — в журнале сервера.';
      res.status(status).type('html').send(installPage(false, message));
    }
  }

  /**
   * Вход в приложение из Битрикс24 (POST на «Путь вашего обработчика», nginx перенаправляет сюда).
   * Если портал ещё не зарегистрирован (установка прошла мимо нас или токены утрачены) и открыл
   * администратор — регистрируем его по данным фрейма с той же проверкой, что и при установке.
   * Затем 303 на SPA: авторизацию интерфейс получает через BX24 SDK.
   */
  @Post('app')
  async entry(@Req() req: Request, @Query() query: InstallRequest, @Body() body: InstallRequest, @Res() res: Response) {
    const memberId = body?.member_id;
    if (memberId && body.REFRESH_ID && body.APPLICATION_TOKEN && !(await this.portals.findActiveByMemberId(memberId))) {
      try {
        const { domain } = await this.install.install(normalizeInstallRequest({ ...query, ...body }));
        this.logger.log(`registered ${domain} on first open`);
      } catch (err) {
        this.logger.warn(`first-open registration skipped: ${err instanceof Bitrix24Error ? `${err.code}: ${err.message}` : (err as Error).message}`);
      }
    }
    const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    res.redirect(303, `/${qs}`);
  }
}
