import { Module } from '@nestjs/common';
import { CrmAccessService } from './crm-access.service.js';
import { CrmMirrorReader } from './crm-mirror.reader.js';

/** Чтение копии CRM с проверкой прав сотрудника (ADR 0013). Запись — в worker (`CrmMirrorService`). */
@Module({
  providers: [CrmAccessService, CrmMirrorReader],
  exports: [CrmAccessService, CrmMirrorReader],
})
export class CrmMirrorModule {}
