import { hashCode, newCode, normalizeCode, SettingsAccessService } from './settings-access.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';

function setup() {
  const rows: Record<string, unknown>[] = [];
  const match = (r: Record<string, unknown>, w: Record<string, unknown>) =>
    r.portalId === w.portalId &&
    r.codeHash === w.codeHash &&
    (w.revokedAt !== null || r.revokedAt === null) &&
    (!w.expiresAt || (r.expiresAt as Date) > (w.expiresAt as { gt: Date }).gt) &&
    (!w.OR || r.usedByUserId === null || r.usedByUserId === (w.OR as { usedByUserId: number | null }[])[1].usedByUserId);
  const prisma = {
    settingsAccessCode: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `c${rows.length + 1}`, createdAt: new Date(), usedByUserId: null, usedAt: null, revokedAt: null, ...data };
        rows.push(row);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = rows.filter((r) => match(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((r) => r.portalId === where.portalId && (where.id ? r.id === where.id : r.codeHash === where.codeHash)) ?? null,
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(rows.find((r) => r.id === where.id)!, data)),
    },
  } as unknown as PrismaService;
  const user = (userId: number) => ({ portal: { id: 'p1' }, userId }) as unknown as B24UserContext;
  return { svc: new SettingsAccessService(prisma), rows, user };
}

describe('SettingsAccessService', () => {
  it('codes are 10 chars without look-alikes; input is case/space/dash-insensitive', () => {
    const c = newCode();
    expect(c).toMatch(/^[A-HJKMNP-Z2-9]{10}$/);
    expect(normalizeCode(' abcd-efgh ')).toBe('ABCDEFGH');
    expect(hashCode('p1', 'abcd efgh')).toBe(hashCode('p1', 'ABCD-EFGH'));
    expect(hashCode('p1', 'ABCD')).not.toBe(hashCode('p2', 'ABCD'));
  });

  it('creates a code for N hours, stores only the hash', async () => {
    const { svc, rows, user } = setup();
    const now = new Date('2026-10-21T10:00:00Z');
    const r = await svc.create(user(1), { hours: 4 }, now);
    expect(r.expiresAt).toBe('2026-10-21T14:00:00.000Z');
    expect(rows[0].codeHash).toBe(hashCode('p1', r.code));
    expect(JSON.stringify(rows[0])).not.toContain(r.code);
    await expect(svc.create(user(1), { hours: 0 })).rejects.toMatchObject({ status: 400 });
    await expect(svc.create(user(1), { hours: 73 })).rejects.toMatchObject({ status: 400 });
  });

  it('one-time: activates for the first employee only; the same employee may repeat', async () => {
    const { svc, user } = setup();
    const now = new Date('2026-10-21T10:00:00Z');
    const { code } = await svc.create(user(1), { hours: 2 }, now);
    expect(await svc.activate(user(7), { code: code.toLowerCase() }, now)).toEqual({ until: '2026-10-21T12:00:00.000Z' });
    expect(await svc.activate(user(7), { code }, now)).toMatchObject({ until: expect.any(String) });
    await expect(svc.activate(user(8), { code }, now)).rejects.toMatchObject({ status: 403 });
  });

  it('expired and revoked codes do not work', async () => {
    const { svc, user } = setup();
    const now = new Date('2026-10-21T10:00:00Z');
    const a = await svc.create(user(1), { hours: 1 }, now);
    await expect(svc.activate(user(7), { code: a.code }, new Date('2026-10-21T11:00:01Z'))).rejects.toMatchObject({ status: 403 });
    const b = await svc.create(user(1), { hours: 1 }, now);
    await svc.revoke('p1', b.id);
    await expect(svc.activate(user(9), { code: b.code }, now)).rejects.toMatchObject({ status: 403 });
  });

  it('locks after 5 wrong attempts for 15 minutes', async () => {
    const { svc, user } = setup();
    const now = new Date('2026-10-21T10:00:00Z');
    const { code } = await svc.create(user(1), { hours: 2 }, now);
    for (let i = 0; i < 5; i++) await expect(svc.activate(user(7), { code: 'WRONG' }, now)).rejects.toMatchObject({ status: 403 });
    await expect(svc.activate(user(7), { code }, now)).rejects.toMatchObject({ status: 429 });
    expect(await svc.activate(user(7), { code }, new Date('2026-10-21T10:15:01Z'))).toMatchObject({ until: expect.any(String) });
  });
});
