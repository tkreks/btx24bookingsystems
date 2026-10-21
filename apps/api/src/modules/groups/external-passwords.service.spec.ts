import { ExternalPasswordsService } from './external-passwords.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { verifyPassword } from '../external-users/password.js';

function setup() {
  const rows = [{ id: 'u1', portalId: 'p1', login: 'viewer', role: 'VIEWER', disabledAt: null, passwordHash: 'old' }];
  const findMany = vi.fn(async ({ where }: { where: { portalId: string } }) =>
    rows.filter((u) => u.portalId === where.portalId),
  );
  const findFirst = vi.fn(
    async ({ where }: { where: { portalId: string; id: string } }) =>
      rows.find((u) => u.portalId === where.portalId && u.id === where.id) ?? null,
  );
  const updateMany = vi.fn(
    async ({ where, data }: { where: { id: string; portalId: string }; data: { passwordHash: string } }) => {
      const row = rows.find((u) => u.id === where.id && u.portalId === where.portalId);
      if (row) row.passwordHash = data.passwordHash;
      return { count: row ? 1 : 0 };
    },
  );
  const prisma = { externalUser: { findMany, findFirst, updateMany } } as unknown as PrismaService;
  return { service: new ExternalPasswordsService(prisma), rows, findMany, findFirst, updateMany };
}

describe('ExternalPasswordsService', () => {
  it('returns only safe user summaries belonging to the portal', async () => {
    const { service, findMany } = setup();
    expect(await service.list('p1')).toEqual([{ id: 'u1', login: 'viewer', role: 'VIEWER', disabled: false }]);
    expect(await service.list('p2')).toEqual([]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: { id: true, login: true, role: true, disabledAt: true } }),
    );
  });
  it('stores only a salted hash and scopes the write to the authenticated portal', async () => {
    const { service, rows, updateMany } = setup();
    const password = 'test-password-12';
    await service.change('p1', 'u1', { password });
    expect(await verifyPassword(password, rows[0].passwordHash)).toBe(true);
    expect(rows[0].passwordHash).not.toContain(password);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'u1', portalId: 'p1' },
      data: { passwordHash: rows[0].passwordHash },
    });
  });
  it('cannot change a user from another portal', async () => {
    const { service, rows, updateMany } = setup();
    await expect(service.change('p2', 'u1', { password: 'test-password-12' })).rejects.toMatchObject({ status: 404 });
    expect(updateMany).not.toHaveBeenCalled();
    expect(rows[0].passwordHash).toBe('old');
  });
  it.each([
    { password: 'short' },
    { password: 'x'.repeat(129) },
    { password: 123 },
    { password: 'test-password-12', portalId: 'p2' },
  ])('rejects invalid input before accessing data', async (body) => {
    const { service, findFirst, updateMany } = setup();
    await expect(service.change('p1', 'u1', body)).rejects.toMatchObject({ status: 400 });
    expect(findFirst).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });
});
