import { TemplatesService } from './templates.service.js';
import type { FilesService } from './files.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';

function setup(existing: { id: string; name: string; steps: unknown; ownerUserId?: number }[] = []) {
  const rows = existing.map((r) => ({
    portalId: 'p1',
    ownerUserId: 7,
    updatedAt: new Date('2026-10-21T00:00:00Z'),
    ...r,
  }));
  const prisma = {
    messageTemplate: {
      findMany: vi.fn(async ({ where }: { where: { ownerUserId: number } }) =>
        rows.filter((r) => r.ownerUserId === where.ownerUserId),
      ),
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; ownerUserId: number } }) =>
          rows.find((r) => r.id === where.id && r.ownerUserId === where.ownerUserId) ?? null,
      ),
      count: vi.fn(async () => rows.length),
      create: vi.fn(async ({ data }: { data: { name: string; steps: unknown } }) => {
        const row = { id: 'new', portalId: 'p1', ownerUserId: 7, updatedAt: new Date(), ...data };
        rows.push(row);
        return row;
      }),
      updateMany: vi.fn(async () => ({ count: 1 })),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
  } as unknown as PrismaService;
  const files = {
    meta: vi.fn(
      async (_u: unknown, ids: string[]) =>
        new Map(ids.map((id) => [id, { id, name: `${id}.pdf`, mime: 'application/pdf', size: 3 }])),
    ),
    assertOwned: vi.fn(async () => undefined),
    dropUnused: vi.fn(async () => undefined),
  } as unknown as FilesService;
  const user = { portal: { id: 'p1' }, userId: 7 } as unknown as B24UserContext;
  return { svc: new TemplatesService(prisma, files), prisma, files, user };
}

describe('TemplatesService', () => {
  it('creates a template for the author with file metadata', async () => {
    const { svc, user, files } = setup();
    const t = await svc.create(user, {
      name: ' Приветствие ',
      steps: [
        { text: 'Добрый день', fileIds: [] },
        { text: '', fileIds: ['f1'] },
      ],
    });
    expect(files.assertOwned).toHaveBeenCalledWith(user, ['f1']);
    expect(t).toMatchObject({
      name: 'Приветствие',
      steps: [
        { text: 'Добрый день', files: [] },
        { fileIds: ['f1'], files: [{ id: 'f1', name: 'f1.pdf' }] },
      ],
    });
  });

  it.each([
    { name: '', steps: [{ text: 'x', fileIds: [] }] },
    { name: 'a', steps: [] },
    { name: 'a', steps: [{ text: '', fileIds: [] }] },
    { name: 'a', steps: Array.from({ length: 21 }, () => ({ text: 'x', fileIds: [] })) },
  ])('rejects %#', async (body) => {
    const { svc, user } = setup();
    await expect(svc.create(user, body)).rejects.toMatchObject({ status: 400 });
  });

  it("does not touch another manager's template and frees files of a deleted one", async () => {
    const { svc, user, files, prisma } = setup([
      { id: 't1', name: 'Мой', steps: [{ text: '', fileIds: ['f9'] }] },
      { id: 't2', name: 'Чужой', steps: [], ownerUserId: 8 },
    ]);
    await expect(svc.remove(user, 't2')).rejects.toMatchObject({ status: 404 });
    await svc.remove(user, 't1');
    expect(prisma.messageTemplate.deleteMany).toHaveBeenCalledWith({
      where: { id: 't1', portalId: 'p1', ownerUserId: 7 },
    });
    expect(files.dropUnused).toHaveBeenCalledWith(user, ['f9']);
  });
});
