import { BadRequestException } from '@nestjs/common';
import { DEFAULT_DASHBOARD } from '@btx24/shared';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { DashboardLayoutService } from './dashboard-layout.service.js';

function setup() {
  const rows = new Map<string, unknown>();
  const key = (w: { portalId_userId: { portalId: string; userId: number } }) => `${w.portalId_userId.portalId}:${w.portalId_userId.userId}`;
  const prisma = {
    dashboardLayout: {
      findUnique: vi.fn(async ({ where }: { where: { portalId_userId: { portalId: string; userId: number } } }) => (rows.has(key(where)) ? { blocks: rows.get(key(where)) } : null)),
      upsert: vi.fn(async ({ where, create }: { where: { portalId_userId: { portalId: string; userId: number } }; create: { blocks: unknown } }) => rows.set(key(where), create.blocks)),
      deleteMany: vi.fn(async () => rows.clear()),
    },
  } as unknown as PrismaService;
  return { svc: new DashboardLayoutService(prisma), rows };
}
const user = (userId = 7) => ({ portal: { id: 'p1' }, userId }) as unknown as B24UserContext;

describe('DashboardLayoutService', () => {
  it('по умолчанию — дашборд менеджера; своя раскладка — у каждого своя; повтор типа отбрасывается', async () => {
    const t = setup();
    expect(await t.svc.get(user(), false)).toEqual({ blocks: DEFAULT_DASHBOARD, isDefault: true });
    const saved = await t.svc.save(user(), false, {
      blocks: [
        { id: 'a', type: 'deals', width: 'full' },
        { id: 'b', type: 'deals', width: 'half' },
        { id: 'c', type: 'dealsChart', width: 'half' },
      ],
    });
    expect(saved.blocks.map((b) => `${b.type}:${b.width}`)).toEqual(['deals:full', 'dealsChart:half']);
    expect((await t.svc.get(user(), false)).isDefault).toBe(false);
    expect((await t.svc.get(user(8), false)).isDefault).toBe(true);
  });

  it('«Активность сотрудников» — только администратору: остальным не сохранить и не показать', async () => {
    const t = setup();
    await expect(t.svc.save(user(), false, { blocks: [{ id: 'x', type: 'activity', width: 'full' }] })).rejects.toBeInstanceOf(BadRequestException);
    await t.svc.save(user(), true, { blocks: [{ id: 'x', type: 'activity', width: 'full' }, { id: 'y', type: 'alerts', width: 'quarter' }] });
    expect((await t.svc.get(user(), true)).blocks.map((b) => b.type)).toEqual(['activity', 'alerts']);
    // Перестал быть администратором — блок не показывается.
    expect((await t.svc.get(user(), false)).blocks.map((b) => b.type)).toEqual(['alerts']);
    await expect(t.svc.save(user(), true, { blocks: [{ id: 'z', type: 'alerts', width: 'double' }] })).rejects.toBeInstanceOf(BadRequestException);
  });
});
