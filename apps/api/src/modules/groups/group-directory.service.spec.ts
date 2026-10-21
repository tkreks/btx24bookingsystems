import type { PrismaService } from '../../prisma/prisma.service.js';
import { GroupDirectoryService } from './group-directory.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { Bitrix24Error } from '../bitrix24/rest/errors.js';

function setup(departmentError?: Error) {
  const listAll = vi.fn(async (method: string, _params?: unknown, options?: { pick?: (r: unknown) => unknown }) => {
    if (method === 'department.get') {
      if (departmentError) throw departmentError;
      return [{ ID: '7', NAME: 'Отдел' }];
    }
    if (method === 'user.get')
      return [
        { ID: '12', NAME: 'Яна', LAST_NAME: 'Ушакова', WORK_POSITION: 'Администратор', UF_DEPARTMENT: [7, 9] },
        { ID: '5', NAME: 'Анна', LAST_NAME: 'Белова', UF_DEPARTMENT: 7 },
      ];
    if (method === 'booking.v1.resource.list') return options!.pick!({ resource: [{ id: '30', name: 'Баня' }] });
    if (method === 'crm.category.list')
      return options!.pick!({
        categories: [
          { id: '0', name: 'Основная' },
          { id: '14', name: 'Бани' },
        ],
      });
    throw new Error(method);
  });
  const call = vi.fn(async () => ({
    result: [
      { ID: '3', NAME: 'Иван', LAST_NAME: 'Петров', WORK_POSITION: 'Менеджер', UF_DEPARTMENT: [7], ACTIVE: true },
      { ID: '4', NAME: 'Уволен', ACTIVE: false, USER_TYPE: 'employee' },
      { ID: '6', NAME: 'Гость', ACTIVE: true, USER_TYPE: 'extranet' },
    ],
  }));
  const user = { portal: { id: 'p1' }, client: { listAll, call } } as unknown as B24UserContext;
  const prisma = {
    workGroupMember: { findMany: vi.fn(async () => []) },
    appAdmin: { findMany: vi.fn(async () => []) },
  } as unknown as PrismaService;
  return { service: new GroupDirectoryService(prisma), user, listAll, call, prisma };
}

describe('GroupDirectoryService', () => {
  it('loads nested lists using the authenticated user client and retains the default funnel id 0', async () => {
    const { service, user, listAll } = setup();
    expect(await service.get(user)).toEqual({
      users: [],
      resources: [{ id: 30, name: 'Баня' }],
      categories: [
        { id: 14, name: 'Бани' },
        { id: 0, name: 'Основная' },
      ],
      departments: [{ id: 7, name: 'Отдел', parentId: null }],
      departmentsAvailable: true,
    });
    expect(listAll).toHaveBeenCalledWith('crm.category.list', { entityTypeId: 2 }, expect.anything());
  });
  it('reports unavailable departments without blocking individual memberships', async () => {
    const { service, user } = setup(new Bitrix24Error('insufficient_scope', 'denied'));
    expect(await service.get(user)).toMatchObject({
      departments: [],
      departmentsAvailable: false,
      resources: [{ id: 30, name: 'Баня' }],
    });
  });
  it.each(['expired_token', 'QUERY_LIMIT_EXCEEDED', 'NETWORK_ERROR'])(
    'does not hide %s behind a permissions fallback',
    async (code) => {
      const error = new Bitrix24Error(code, code);
      const { service, user } = setup(error);
      await expect(service.get(user)).rejects.toBe(error);
    },
  );
  it('does not cache one portal or user directory for another', async () => {
    const { service, user } = setup();
    await service.get(user);
    const other = setup();
    other.listAll.mockImplementation(async () => []);
    expect(await service.get(other.user)).toEqual({
      users: [],
      resources: [],
      categories: [],
      departments: [],
      departmentsAvailable: true,
    });
  });
});

it('looks up only saved employee memberships in the authenticated portal and exposes only names', async () => {
  const { service, user, prisma, listAll } = setup();
  vi.mocked(prisma.workGroupMember.findMany).mockResolvedValue([
    { id: 'm1', groupId: 'g1', kind: 'USER', bitrixId: 42, role: 'MANAGER' },
  ]);
  listAll.mockImplementation(async (method) =>
    method === 'user.get' ? [{ ID: '42', NAME: 'Иван', LAST_NAME: 'Иванов', EMAIL: 'private@example.test' }] : [],
  );
  const result = await service.get(user);
  expect(result.users).toEqual([{ id: 42, name: 'Иван Иванов' }]);
  expect(prisma.workGroupMember.findMany).toHaveBeenCalledWith({
    where: { kind: 'USER', group: { portalId: 'p1', archivedAt: null } },
    select: { bitrixId: true },
  });
  expect(listAll).toHaveBeenCalledWith('user.get', { FILTER: { ID: [42] } });
});

describe('GroupDirectoryService.employees', () => {
  it('searches active employees by name, position or department name', async () => {
    const { service, user, call } = setup();
    expect(await service.employees(user, { q: ' Пет ' })).toEqual([
      { id: 3, name: 'Иван Петров', position: 'Менеджер', departmentIds: [7] },
    ]);
    expect(call).toHaveBeenCalledWith('user.search', { FILTER: { FIND: 'Пет' } });
  });
  it('lists the active employees of a department', async () => {
    const { service, user, listAll } = setup();
    expect(await service.employees(user, { departmentId: '7' })).toEqual([
      { id: 5, name: 'Анна Белова', position: '', departmentIds: [7] },
      { id: 12, name: 'Яна Ушакова', position: 'Администратор', departmentIds: [7, 9] },
    ]);
    expect(listAll).toHaveBeenCalledWith('user.get', { FILTER: { UF_DEPARTMENT: 7, ACTIVE: true } });
  });
  it.each([{}, { q: 'a' }, { q: 'Иван', departmentId: 7 }, { departmentId: 'x' }, { q: 'Иван', extra: 1 }])(
    'rejects %o',
    async (query) => {
      const { service, user } = setup();
      await expect(service.employees(user, query)).rejects.toMatchObject({ status: 400 });
    },
  );
});
