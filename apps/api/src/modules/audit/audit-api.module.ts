import { CrmMirrorModule } from '../crm-mirror/crm-mirror.module.js';
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AccessModule } from '../access/access.module.js';
import { ActionLogController } from './action-log.controller.js';
import { RequestLogInterceptor } from './request-log.interceptor.js';

/** HTTP-часть журнала действий (только api): вход, просмотр, запись всех изменяющих запросов. */
@Module({
  imports: [AccessModule, CrmMirrorModule],
  controllers: [ActionLogController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: RequestLogInterceptor }],
})
export class AuditApiModule {}
