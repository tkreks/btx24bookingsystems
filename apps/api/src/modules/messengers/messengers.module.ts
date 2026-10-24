import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { Bitrix24Module } from '../bitrix24/bitrix24.module.js';
import { MessengerServiceClient } from './messenger-service.client.js';
import { MessengerCrmService } from './messenger-crm.service.js';
import { MediaLinks } from './media-links.js';
import { MessengerHookController, MessengerPublicFilesController, MessengersController, MessengerUserController } from './messengers.controller.js';
import { MessengerChatsService } from './messenger-chats.service.js';
import { MessengerConnectorService } from './messenger-connector.service.js';
import { MessengerInboxService } from './messenger-inbox.service.js';
import { MessengersService } from './messengers.service.js';

/** Мессенджеры портала (ADR 0014): записи в базе + браузеры в сервисе messenger. */
@Module({
  imports: [AccessModule, Bitrix24Module],
  controllers: [MessengersController, MessengerHookController, MessengerUserController, MessengerPublicFilesController],
  providers: [MessengerCrmService, MediaLinks, MessengerServiceClient, MessengersService, MessengerInboxService, MessengerConnectorService, MessengerChatsService],
  exports: [MessengerServiceClient],
})
export class MessengersModule {}
