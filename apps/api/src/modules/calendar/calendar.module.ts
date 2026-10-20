import { Module } from '@nestjs/common';
import { Bitrix24Module } from '../bitrix24/bitrix24.module.js';
import { CalendarController } from './calendar.controller.js';
import { CalendarService } from './calendar.service.js';

@Module({
  imports: [Bitrix24Module],
  controllers: [CalendarController],
  providers: [CalendarService],
})
export class CalendarModule {}
