import { Module } from '@nestjs/common';
import { Bitrix24Module } from '../bitrix24/bitrix24.module.js';
import { WorkdayController } from './workday.controller.js';
import { OnShiftService } from './on-shift.service.js';
import { WorkdayService } from './workday.service.js';

@Module({
  imports: [Bitrix24Module],
  controllers: [WorkdayController],
  providers: [WorkdayService, OnShiftService],
})
export class WorkdayModule {}
