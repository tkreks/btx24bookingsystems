import { TemplatesService } from './templates.service.js';
import type { FilesService } from './files.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';

type Where = { id?: string; ownerUserId?: number; OR?: ({ ownerUserId: number } | { shared: boolean })[] };
function setup(
  existing: { id: string; name: string; steps: unknown; ownerUserId?: number; shared?: boolean; purpose?: 'chat' | 'payment' }[] = [],
  groups: { name: string; options: unknown }[] = [],
) {
  const rows = existing.map((r) => ({
    portalId: 'p1',
    ownerUserId: 7,
    shared: false,
    purpose: 'chat' as 'chat' | 'payment',
    updatedAt: new Date('2026-10-21T00:00:00Z'),
    ...r,
  }));
  const match = (r: (typeof rows)[number], w: Where) =>
    (!w.id || r.id === w.id) &&
    (w.OR ? w.OR.some((c) => ('ownerUserId' in c ? r.ownerUserId === c.ownerUserId : r.shared === c.shared)) : w.ownerUserId === undefined || r.ownerUserId === w.ownerUserId);
  const prisma = {
    messageTemplate: {
      findMany: vi.fn(async ({ where }: { where: Where }) => rows.filter((r) => match(r, where))),
      findFirst: vi.fn(async ({ where }: { where: Where }) => rows.find((r) => match(r, where)) ?? null),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: object }) => Object.assign(rows.find((r) => r.id === where.id)!, data)),
      delete: vi.fn(async () => ({})),
      count: vi.fn(async () => rows.length),
      create: vi.fn(async ({ data }: { data: { name: string; steps: unknown; shared: boolean } }) => {
        const row = { id: 'new', portalId: 'p1', ownerUserId: 7, updatedAt: new Date(), purpose: 'chat' as 'chat' | 'payment', ...data };
        rows.push(row);
        return row;
      }),
      updateMany: vi.fn(async () => ({ count: 1 })),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    workGroup: { findMany: vi.fn(async () => groups) },
    actionLog: { groupBy: vi.fn(async () => [{ entityId: 't1', _count: { _all: 3 } }]), create: vi.fn(async () => ({})) },
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
    expect(prisma.messageTemplate.delete).toHaveBeenCalledWith({ where: { id: 't1' } });
    expect(files.dropUnused).toHaveBeenCalledWith(user, ['f9']);
  });

  it('everyone sees shared templates; only admins create or change them', async () => {
    const t = setup([
      { id: 's1', name: 'Приветствие', steps: [{ text: 'Здравствуйте', fileIds: [] }], ownerUserId: 1, shared: true },
      { id: 't2', name: 'Чужой личный', steps: [], ownerUserId: 8 },
    ]);
    const list = await t.svc.list(t.user);
    expect(list.map((x) => [x.id, x.shared, x.mine, x.canEdit])).toEqual([['s1', true, false, false]]);
    expect((await t.svc.list(t.user, true))[0].canEdit).toBe(true);
    await expect(t.svc.update(t.user, 's1', { name: 'x', steps: [{ text: 'y', fileIds: [] }] })).rejects.toMatchObject({ status: 403 });
    await expect(t.svc.create(t.user, { name: 'Общий', shared: true, steps: [{ text: 'y', fileIds: [] }] })).rejects.toMatchObject({ status: 403 });
    expect(await t.svc.update(t.user, 's1', { name: 'Приветствие 2', steps: [{ text: 'y', fileIds: [] }] }, true)).toMatchObject({ name: 'Приветствие 2', shared: true });
    expect(await t.svc.create(t.user, { name: 'Общий', shared: true, steps: [{ text: 'y', fileIds: [] }] }, true)).toMatchObject({ shared: true, mine: true });
  });

  it('payment templates are shared, admin-only and cannot be removed while a group uses them', async () => {
    const t = setup([{ id: 'p1', name: 'Предоплата бани', steps: [{ text: '{link}', fileIds: [] }], ownerUserId: 1, shared: true, purpose: 'payment' }], [
      { name: 'Бани', options: { payments: { prepaymentTemplateId: 'p1' } } },
    ]);
    const body = { name: 'Оплата', purpose: 'payment', steps: [{ text: 'Ссылка: {link}', fileIds: [] }] };
    await expect(t.svc.create(t.user, body)).rejects.toMatchObject({ status: 403 });
    expect(await t.svc.create(t.user, { ...body, shared: false }, true)).toMatchObject({ purpose: 'payment', shared: true });
    await expect(t.svc.remove(t.user, 'p1', true)).rejects.toMatchObject({ status: 409, response: { message: expect.stringContaining('Бани (предоплата)') } });
    await expect(t.svc.update(t.user, 'p1', { ...body, purpose: 'chat' }, true)).rejects.toMatchObject({ status: 409 });
    expect(await t.svc.update(t.user, 'p1', { name: 'Предоплата', shared: false, steps: body.steps }, true)).toMatchObject({ shared: true, purpose: 'payment' });
  });

  it('частота шаблонов: вставки за 30 дней в журнале; чужой личный шаблон отметить нельзя', async () => {
    const { svc, user, prisma } = setup([{ id: 't1', name: 'Привет', steps: [{ text: 'a', fileIds: [] }] }, { id: 't2', name: 'Чужой', steps: [{ text: 'b', fileIds: [] }], ownerUserId: 9 }]);
    expect((await svc.list(user)).map((t) => [t.id, t.uses30d])).toEqual([['t1', 3]]);
    await svc.markUsed(user, 't1');
    expect(prisma.actionLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'template.use', entityType: 'template', entityId: 't1', userId: 7 }) });
    await expect(svc.markUsed(user, 't2')).rejects.toMatchObject({ status: 404 });
  });
});
