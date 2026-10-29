import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { CrmMirrorModule } from '../crm-mirror/crm-mirror.module.js';
import { CalendarController } from './calendar.controller.js';
import { CalendarService } from './calendar.service.js';

@Module({
  imports: [AccessModule, CrmMirrorModule],
  controllers: [CalendarController],
  providers: [CalendarService],
})
export class CalendarModule {}
