import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { Bitrix24Module } from '../bitrix24/bitrix24.module.js';
import { DealFieldMapService } from '../bookings/deal-field-map.service.js';
import { ExternalAuthGuard } from './external-auth.guard.js';
import { ExternalAuthService } from './external-auth.service.js';
import { ExternalController } from './external.controller.js';
import { ViewerService } from './viewer.service.js';

/** Внешние пользователи: вход по логину и паролю, экран «Бронирования» для роли viewer (ADR 0021). */
@Module({
  imports: [AuditModule, Bitrix24Module],
  controllers: [ExternalController],
  providers: [ExternalAuthService, ExternalAuthGuard, ViewerService, DealFieldMapService],
})
export class ExternalUsersModule {}
