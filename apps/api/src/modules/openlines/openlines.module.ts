import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { BookingsModule } from '../bookings/bookings.module.js';
import { ChatsService } from './chats.service.js';
import { DashboardService } from './dashboard.service.js';
import { FilesService } from './files.service.js';
import { OpenlineIndexService } from './openline-index.service.js';
import { OpenlinesController } from './openlines.controller.js';
import { TemplatesService } from './templates.service.js';

@Module({
  imports: [AccessModule, BookingsModule],
  controllers: [OpenlinesController],
  providers: [ChatsService, DashboardService, FilesService, OpenlineIndexService, TemplatesService],
})
export class OpenlinesModule {}
