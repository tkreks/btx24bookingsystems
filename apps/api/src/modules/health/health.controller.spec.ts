import { HealthController } from './health.controller.js';
import type { PrismaService } from '../../prisma/prisma.service.js';

describe('HealthController', () => {
  it('reports ok when the DB answers', async () => {
    const prisma = { isAlive: vi.fn().mockResolvedValue(true) } as unknown as PrismaService;
    const res = await new HealthController(prisma).check();
    expect(res).toMatchObject({ status: 'ok', db: 'up' });
  });

  it('reports degraded (not an exception) when the DB is down', async () => {
    const prisma = { isAlive: vi.fn().mockResolvedValue(false) } as unknown as PrismaService;
    const res = await new HealthController(prisma).check();
    expect(res).toMatchObject({ status: 'degraded', db: 'down' });
  });
});
