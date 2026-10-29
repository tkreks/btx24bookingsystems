import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { BookingsModule } from '../bookings/bookings.module.js';
import { FieldsController } from './fields.controller.js';
import { FieldsService } from './fields.service.js';
@Module({ imports: [AccessModule, BookingsModule], controllers: [FieldsController], providers: [FieldsService] })
export class FieldsModule {}
