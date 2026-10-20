import { PrototypeImportService } from './import.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';

const sample = {
  version: 8,
  groups: [{ id: 'g1', title: 'Бани', bookingMode: 'duration', durationHours: 2, resourceIds: [1] }],
  externalUsers: [{ login: 'viewer', password: 'super-secret-pw', role: 'viewer', groupIds: ['g1'] }],
};

function fakePrisma() {
  const writes: { op: string; data: unknown }[] = [];
  const rec = (op: string) => vi.fn(async (args: unknown) => {
    writes.push({ op, data: args });
    return { id: `${op}-id` };
  });
  const tx = {
    workGroup: { upsert: rec('workGroup.upsert') },
    workGroupResource: { deleteMany: rec('res.delete'), createMany: rec('res.create') },
    externalUser: { upsert: rec('externalUser.upsert') },
    externalUserGroup: { deleteMany: rec('eug.delete'), createMany: rec('eug.create') },
    portalSettings: { upsert: rec('settings.upsert') },
  };
  const prisma = {
    workGroup: { findMany: vi.fn(async () => []) },
    externalUser: { findMany: vi.fn(async () => [{ login: 'viewer' }]) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return { prisma: prisma as unknown as PrismaService, writes };
}

describe('PrototypeImportService', () => {
  it('dry run reports actions and writes nothing', async () => {
    const { prisma, writes } = fakePrisma();
    const s = await new PrototypeImportService(prisma).run('p1', sample, false);
    expect(s).toMatchObject({ applied: false, groups: [{ name: 'Бани', action: 'create', resources: 1 }], externalUsers: [{ login: 'viewer', action: 'update' }] });
    expect(writes).toHaveLength(0);
    expect(JSON.stringify(s)).not.toContain('super-secret-pw');
  });

  it('apply stores only a password hash and links groups by legacy id', async () => {
    const { prisma, writes } = fakePrisma();
    await new PrototypeImportService(prisma).run('p1', sample, true);
    const all = JSON.stringify(writes);
    expect(all).not.toContain('super-secret-pw');
    expect(all).toContain('scrypt$');
    const link = writes.find((w) => w.op === 'eug.create')!.data as { data: { groupId: string }[] };
    expect(link.data).toEqual([{ externalUserId: 'externalUser.upsert-id', groupId: 'workGroup.upsert-id' }]);
    const groupUpsert = writes.find((w) => w.op === 'workGroup.upsert')!.data as { create: { features: string[] }; update: Record<string, unknown> };
    expect(groupUpsert.create.features.length).toBeGreaterThan(0);
    expect(groupUpsert.update).not.toHaveProperty('features'); // повторный импорт не сбрасывает функции, настроенные вручную
  });
});
