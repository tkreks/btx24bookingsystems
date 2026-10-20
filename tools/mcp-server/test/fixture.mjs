// Временный мини-репозиторий для тестов: файлы создаются в os.tmpdir() и удаляются после.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const FIXTURE_FILES = {
  'package.json': JSON.stringify({ name: 'fixture', workspaces: ['apps/*', 'packages/*'], scripts: { test: 'x' } }),
  'apps/api/package.json': JSON.stringify({ name: '@fx/api' }),
  'AGENTS.md': '# Rules\n\n## Bookings\nNo overlaps.\n',
  'apps/api/src/modules/bookings/MODULE.md': '# bookings\n\nInvariant: no overlapping bookings per resource.\n',
  'apps/api/src/modules/bookings/bookings.controller.ts': [
    "import { Controller, Get, Post } from '@nestjs/common';",
    '',
    "@Controller('bookings')",
    'export class BookingsController {',
    '  @Get()',
    '  list() {',
    '    return [];',
    '  }',
    '',
    "  @Post(':id/cancel')",
    '  async cancelBooking() {',
    '    return { ok: true };',
    '  }',
    '}',
  ].join('\n'),
  'apps/api/src/modules/bookings/bookings.service.ts': [
    'export interface BookingSlot {',
    '  start: Date;',
    '}',
    '',
    'export function assertNoOverlap(a: BookingSlot, b: BookingSlot) {',
    '  const dbUrl = "postgresql://app:supersecret@db:5432/app";',
    '  return a.start !== b.start;',
    '}',
  ].join('\n'),
  'apps/api/src/modules/bookings/bookings.service.spec.ts': "it('works', () => {});\n",
  'apps/api/prisma/schema.prisma': 'model Booking {\n  id String @id\n}\n\nenum BookingStatus {\n  CONFIRMED\n}\n',
  'docs/bitrix24/README.md': '# Битрикс24\n\n## Установка приложения\ntext\n',
  '.env': 'AGENT_DB_PASSWORD=topsecret\n',
  'apps/api/.env': 'DATABASE_URL=postgresql://a:b@c/d\n',
  'node_modules/x/index.js': 'export const hidden = 1;\n',
  '.agent/tasks/T-1.md': '# Task T-1\nGoal: test\n',
};

export function makeFixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'btx-mcp-fixture-'));
  for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

export function removeFixtureRepo(root) {
  fs.rmSync(root, { recursive: true, force: true });
}
