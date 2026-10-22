import { Global, Module } from '@nestjs/common';
import { ActionLogService } from './action-log.service.js';

/** Журнал действий: сервис записи — во всех модулях (api и worker) без отдельного импорта. */
@Global()
@Module({
  providers: [ActionLogService],
  exports: [ActionLogService],
})
export class AuditModule {}
