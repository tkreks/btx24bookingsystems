import { Body, Controller, Get, HttpCode, Logger, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Bitrix24Error } from '../rest/errors.js';
import { installPage } from './install-page.js';
import { InstallService, type InstallRequest } from './install.service.js';

/** URL установки в настройках локального приложения: `<APP_BASE_URL>/api/b24/install`. */
@Controller('b24/install')
export class InstallController {
  private readonly logger = new Logger(InstallController.name);

  constructor(private readonly install: InstallService) {}

  @Get()
  page(@Res() res: Response) {
    res.status(400).type('html').send(installPage(false, 'Откройте установку из Битрикс24.'));
  }

  @Post()
  @HttpCode(200)
  async handle(@Query() query: InstallRequest, @Body() body: InstallRequest, @Res() res: Response) {
    try {
      const { domain } = await this.install.install({ ...query, ...body });
      res.type('html').send(installPage(true, `Приложение установлено на портал ${domain}.`));
    } catch (err) {
      const known = err instanceof Bitrix24Error;
      this.logger.warn(`install failed: ${known ? err.code : (err as Error).message}`);
      const status = known && err.code === 'NOT_ADMIN' ? 403 : known ? 400 : 500;
      const message = known && err.code === 'NOT_ADMIN' ? 'Установить приложение может только администратор Битрикс24.' : 'Не удалось установить приложение. Подробности — в журнале сервера.';
      res.status(status).type('html').send(installPage(false, message));
    }
  }
}
