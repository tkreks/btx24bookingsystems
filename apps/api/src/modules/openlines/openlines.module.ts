import { Bitrix24Module } from '../bitrix24/bitrix24.module.js';
import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { BookingsModule } from '../bookings/bookings.module.js';
import { CrmMirrorModule } from '../crm-mirror/crm-mirror.module.js';
import { ActivityService } from './activity.service.js';
import { ClientTimelineService } from './client-timeline.service.js';
import { CallCardService } from './call-card.service.js';
import { CallsController } from './calls.controller.js';
import { DashboardLayoutService } from './dashboard-layout.service.js';
import { ChatFoldersService } from './chat-folders.service.js';
import { ChatsService } from './chats.service.js';
import { DashboardGapsController, DashboardGapsService } from './dashboard-gaps.service.js';
import { DashboardService } from './dashboard.service.js';
import { FilesService } from './files.service.js';
import { OpenlineIndexService } from './openline-index.service.js';
import { OpenlinesController } from './openlines.controller.js';
import { TemplatesService } from './templates.service.js';
import { HeadDashboardService } from './head-dashboard.service.js';

@Module({
  imports: [AccessModule, BookingsModule, Bitrix24Module, CrmMirrorModule],
  controllers: [DashboardGapsController, OpenlinesController, CallsController],
  providers: [DashboardGapsService, ActivityService, ClientTimelineService, CallCardService, DashboardLayoutService, ChatFoldersService, ChatsService, DashboardService, FilesService, HeadDashboardService, OpenlineIndexService, TemplatesService],
})
export class OpenlinesModule {}
