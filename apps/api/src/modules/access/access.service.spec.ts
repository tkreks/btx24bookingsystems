import { AccessService } from './access.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { Bitrix24Error } from '../bitrix24/rest/errors.js';

type Member = { kind: 'USER' | 'DEPARTMENT'; bitrixId: number; role: string };
const group = (id: string, members: Member[], features: string[] = ['booking.details', 'booking.create'], resources = [1]) => ({
  id, portalId: 'p1', name: id, sort: 0, dealCategoryId: 14, bookingMode: 'duration', durationMinutes: 60, checkInTime: '14:00', checkOutTime: '12:00',
  defaultNights: 1, techWindowMinutes: 0, features, archivedAt: null, createdAt: new Date(), updatedAt: new Date(),
  resources: resources.map((resourceId) => ({ groupId: id, resourceId })), members,
});

function setup(opts: { groups: ReturnType<typeof group>[]; admins?: { kind: string; bitrixId: number }[]; departments?: { ID: string; PARENT: string | null }[] | 'denied' }) {
  const prisma = {
    appAdmin: { findMany: vi.fn(async () => opts.admins ?? []) },
    workGroup: { findMany: vi.fn(async () => opts.groups) },
  } as unknown as PrismaService;
  const listAll = vi.fn(async () => {
    if (opts.departments === 'denied') throw new Bitrix24Error('insufficient_scope', 'no department scope');
    return opts.departments ?? [];
  });
  const user = (over: Partial<B24UserContext> = {}) =>
    ({ portal: { id: 'p1' }, userId: 10, userName: 'U', isAdmin: false, departmentIds: [], client: { listAll }, ...over }) as unknown as B24UserContext;
  return { svc: new AccessService(prisma), user, listAll };
}

describe('AccessService', () => {
  it('grants a group to a directly listed user with role ∩ features', async () => {
    const { svc, user } = setup({ groups: [group('g1', [{ kind: 'USER', bitrixId: 10, role: 'MANAGER' }])] });
    const a = await svc.resolve(user());
    expect(a.isAppAdmin).toBe(false);
    expect(a.groups[0]).toMatchObject({ role: 'MANAGER', permissions: ['calendar.view', 'booking.details', 'booking.create'] });
  });

  it('hides groups the user is not a member of', async () => {
    const { svc, user } = setup({ groups: [group('g1', [{ kind: 'USER', bitrixId: 99, role: 'MANAGER' }])] });
    expect((await svc.resolve(user())).groups).toEqual([]);
  });

  it('matches department members including parent departments, and takes the higher department role', async () => {
    const { svc, user } = setup({
      groups: [group('g1', [{ kind: 'DEPARTMENT', bitrixId: 1, role: 'VIEWER' }, { kind: 'DEPARTMENT', bitrixId: 5, role: 'MANAGER' }]), group('g2', [{ kind: 'DEPARTMENT', bitrixId: 1, role: 'VIEWER' }])],
      departments: [{ ID: '1', PARENT: null }, { ID: '5', PARENT: '1' }, { ID: '7', PARENT: '5' }],
    });
    const a = await svc.resolve(user({ departmentIds: [7] }));
    expect(a.groups.map((g) => [g.group.id, g.role])).toEqual([['g1', 'MANAGER'], ['g2', 'VIEWER']]);
  });

  it('a personal role overrides department roles in both directions', async () => {
    const { svc, user } = setup({
      groups: [
        group('up', [{ kind: 'DEPARTMENT', bitrixId: 7, role: 'VIEWER' }, { kind: 'USER', bitrixId: 10, role: 'MANAGER' }]),
        group('down', [{ kind: 'DEPARTMENT', bitrixId: 7, role: 'MANAGER' }, { kind: 'USER', bitrixId: 10, role: 'VIEWER' }]),
      ],
      departments: [{ ID: '7', PARENT: null }],
    });
    const a = await svc.resolve(user({ departmentIds: [7] }));
    expect(a.groups.map((g) => [g.group.id, g.role])).toEqual([['up', 'MANAGER'], ['down', 'VIEWER']]);
  });

  it('falls back to direct departments when department.get is not allowed', async () => {
    const { svc, user } = setup({ groups: [group('g1', [{ kind: 'DEPARTMENT', bitrixId: 1, role: 'VIEWER' }]), group('g2', [{ kind: 'DEPARTMENT', bitrixId: 7, role: 'VIEWER' }])], departments: 'denied' });
    const a = await svc.resolve(user({ departmentIds: [7] }));
    expect(a.groups.map((g) => g.group.id)).toEqual(['g2']);
  });

  it('technologist gets calendar.view only, even if the group enables details', async () => {
    const { svc, user } = setup({ groups: [group('g1', [{ kind: 'USER', bitrixId: 10, role: 'TECHNOLOGIST' }])] });
    expect((await svc.resolve(user())).groups[0].permissions).toEqual(['calendar.view']);
  });

  it('portal admins and listed app admins see every group as APP_ADMIN', async () => {
    const g = [group('g1', [])];
    const portalAdmin = setup({ groups: g });
    expect((await portalAdmin.svc.resolve(portalAdmin.user({ isAdmin: true }))).groups[0].role).toBe('APP_ADMIN');
    const listed = setup({ groups: g, admins: [{ kind: 'DEPARTMENT', bitrixId: 3 }] });
    const a = await listed.svc.resolve(listed.user({ departmentIds: [3] }));
    expect(a.isAppAdmin).toBe(true);
    expect(a.groups[0].permissions).toContain('group.manage');
  });

  it('pick() requires the permission and the requested group', async () => {
    const { svc, user } = setup({ groups: [group('g1', [{ kind: 'USER', bitrixId: 10, role: 'VIEWER' }]), group('g2', [{ kind: 'USER', bitrixId: 10, role: 'MANAGER' }])] });
    const a = await svc.resolve(user());
    expect(svc.pick(a, 'g2', 'booking.create')?.group.id).toBe('g2');
    expect(svc.pick(a, 'g1', 'booking.create')).toBeNull();
    expect(svc.pick(a, undefined, 'booking.create')?.group.id).toBe('g2');
    expect(svc.pick(a, 'other', 'calendar.view')).toBeNull();
  });
});
