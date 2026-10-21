import { Module } from '@nestjs/common';
import { Bitrix24Module } from '../bitrix24/bitrix24.module.js';
import { AccessService } from './access.service.js';
import { AppAdminGuard } from './app-admin.guard.js';
import { PermanentAdminGuard } from './permanent-admin.guard.js';
import { SessionController } from './session.controller.js';
import { SettingsAccessController, SettingsCodesAdminController } from './settings-access.controller.js';
import { SettingsAccessService } from './settings-access.service.js';

@Module({
  imports: [Bitrix24Module],
  controllers: [SessionController, SettingsAccessController, SettingsCodesAdminController],
  providers: [AccessService, AppAdminGuard, PermanentAdminGuard, SettingsAccessService],
  exports: [AccessService, AppAdminGuard, PermanentAdminGuard, Bitrix24Module],
})
export class AccessModule {}
