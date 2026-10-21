import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PortalService } from '../modules/bitrix24/portals/portal.service.js';
import { Bitrix24Error } from '../modules/bitrix24/rest/errors.js';

/**
 * Удаление броней, созданных песочницей записи (журнал SandboxBooking), — и только их.
 *   node dist/scripts/sandbox-cleanup.js --member <member_id> [--apply]
 */
const args = process.argv.slice(2);
const member = args[args.indexOf('--member') + 1];
const apply = args.includes('--apply');
if (args.indexOf('--member') === -1 || !member) {
  console.error('usage: sandbox-cleanup --member <member_id> [--apply]');
  process.exit(2);
}

const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
try {
  const prisma = app.get(PrismaService);
  const portals = app.get(PortalService);
  const portal = await portals.findActiveByMemberId(member);
  if (!portal) throw new Error(`Active portal ${member} not found`);
  const rows = await prisma.sandboxBooking.findMany({ where: { portalId: portal.id, deletedAt: null }, orderBy: { createdAt: 'asc' } });
  console.log(`sandbox bookings to delete on ${portal.domain}: ${rows.map((r) => r.bookingId).join(', ') || 'none'}`);
  if (apply) {
    const client = portals.clientFor(portal);
    for (const r of rows) {
      try {
        await client.call('booking.v1.booking.delete', { id: r.bookingId });
        console.log(`deleted ${r.bookingId}`);
      } catch (err) {
        // Уже удалена в Битрикс24 вручную — просто закрываем запись журнала.
        if (err instanceof Bitrix24Error && /not.?found|не найден/i.test(err.message)) {
          await prisma.sandboxBooking.update({ where: { id: r.id }, data: { deletedAt: new Date() } });
          console.log(`${r.bookingId} already gone`);
        } else throw err;
      }
    }
  }
} finally {
  await app.close();
}
