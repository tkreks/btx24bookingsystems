import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { validateEnv } from '../config/env.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PrototypeImportModule } from '../modules/prototype-import/prototype-import.module.js';
import { PrototypeImportService } from '../modules/prototype-import/import.service.js';

/**
 * Импорт настроек прототипа Node-RED:
 *   node dist/scripts/import-prototype.js <file.json> --member <member_id> [--apply]
 * Без --apply — пробный прогон (только отчёт). Пароли в вывод не попадают.
 */
@Module({ imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }), PrismaModule, PrototypeImportModule] })
class ImportModule {}

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const member = args[args.indexOf('--member') + 1];
const apply = args.includes('--apply');
if (!file || !member || args.indexOf('--member') === -1) {
  console.error('usage: import-prototype <file.json> --member <member_id> [--apply]');
  process.exit(2);
}

const app = await NestFactory.createApplicationContext(ImportModule, { logger: ['error', 'warn'] });
try {
  const portal = await app.get(PrismaService).portal.findFirst({ where: { memberId: member, status: 'ACTIVE' } });
  if (!portal) throw new Error(`Active portal ${member} not found`);
  const summary = await app.get(PrototypeImportService).run(portal.id, JSON.parse(readFileSync(file, 'utf8')), apply);
  console.log(JSON.stringify({ portal: portal.domain, ...summary }, null, 2));
} finally {
  await app.close();
}
