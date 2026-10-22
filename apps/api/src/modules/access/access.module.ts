import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Bitrix24Module } from '../bitrix24/bitrix24.module.js';
import { AccessService } from './access.service.js';
import { AppAccessInterceptor } from './app-access.interceptor.js';
import { AppAdminGuard } from './app-admin.guard.js';
import { PermanentAdminGuard } from './permanent-admin.guard.js';
import { SessionController } from './session.controller.js';
import { SettingsAccessController, SettingsCodesAdminController } from './settings-access.controller.js';
import { SettingsAccessService } from './settings-access.service.js';
import { WebLoginController } from './web-login.controller.js';

@Module({
  imports: [Bitrix24Module],
  controllers: [SessionController, SettingsAccessController, SettingsCodesAdminController, WebLoginController],
  providers: [AccessService, AppAdminGuard, PermanentAdminGuard, SettingsAccessService, { provide: APP_INTERCEPTOR, useClass: AppAccessInterceptor }],
  exports: [AccessService, AppAdminGuard, PermanentAdminGuard, Bitrix24Module],
})
export class AccessModule {}
