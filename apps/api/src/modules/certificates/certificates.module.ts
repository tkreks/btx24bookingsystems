import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { BookingsModule } from '../bookings/bookings.module.js';
import { CertificatesController } from './certificates.controller.js';
import { CertificatesService } from './certificates.service.js';

@Module({
  imports: [AccessModule, BookingsModule],
  controllers: [CertificatesController],
  providers: [CertificatesService],
})
export class CertificatesModule {}
