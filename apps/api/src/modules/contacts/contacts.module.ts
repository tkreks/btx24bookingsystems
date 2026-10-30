import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { CrmMirrorModule } from '../crm-mirror/crm-mirror.module.js';
import { ContactAlertsService } from './contact-alerts.service.js';
import { ContactAlertsController } from './contacts.controller.js';
import { ContactDuplicatesController } from './contact-duplicates.controller.js';
import { ContactDuplicatesService } from './contact-duplicates.service.js';
import { ContactMergeService } from './contact-merge.service.js';
@Module({
  imports: [AccessModule, CrmMirrorModule],
  providers: [ContactAlertsService, ContactDuplicatesService, ContactMergeService],
  controllers: [ContactAlertsController, ContactDuplicatesController],
})
export class ContactsModule {}
