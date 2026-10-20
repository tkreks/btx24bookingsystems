import { Module } from '@nestjs/common';
import { Bitrix24Module } from '../bitrix24/bitrix24.module.js';
import { AccessService } from './access.service.js';
import { AppAdminGuard } from './app-admin.guard.js';
import { SessionController } from './session.controller.js';

@Module({
  imports: [Bitrix24Module],
  controllers: [SessionController],
  providers: [AccessService, AppAdminGuard],
  exports: [AccessService, AppAdminGuard, Bitrix24Module],
})
export class AccessModule {}
