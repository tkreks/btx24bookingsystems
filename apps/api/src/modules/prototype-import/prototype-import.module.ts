import { Module } from '@nestjs/common';
import { PrototypeImportService } from './import.service.js';

@Module({ providers: [PrototypeImportService], exports: [PrototypeImportService] })
export class PrototypeImportModule {}
