import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { CrmMirrorModule } from '../crm-mirror/crm-mirror.module.js';
import { ContactAlertsService } from './contact-alerts.service.js';
import { ContactAlertsController } from './contacts.controller.js';
@Module({ imports: [AccessModule, CrmMirrorModule], providers: [ContactAlertsService], controllers: [ContactAlertsController] })
export class ContactsModule {}
