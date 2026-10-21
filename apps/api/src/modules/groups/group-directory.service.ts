import { BadRequestException, Injectable } from '@nestjs/common';
import type { DepartmentItem, EmployeeDto, GroupDirectoryDto, NamedBitrixItem } from '@btx24/shared';
import { z } from 'zod';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { Bitrix24Error } from '../bitrix24/rest/errors.js';

type BitrixUser = {
  ID: string;
  NAME?: string;
  LAST_NAME?: string;
  WORK_POSITION?: string;
  UF_DEPARTMENT?: (number | string)[] | number | string;
  ACTIVE?: boolean | string;
  USER_TYPE?: string;
};

const employeeQuery = z
  .object({
    q: z.string().trim().min(2).max(100).optional(),
    departmentId: z.coerce.number().int().positive().optional(),
  })
  .strict()
  .refine((v) => (v.q === undefined) !== (v.departmentId === undefined));

const fullName = (u: BitrixUser) => [u.NAME, u.LAST_NAME].filter(Boolean).join(' ') || `Сотрудник #${u.ID}`;

@Injectable()
export class GroupDirectoryService {
  constructor(private readonly prisma: PrismaService) {}
  async get(user: B24UserContext): Promise<GroupDirectoryDto> {
    const [resources, categories, departments, users] = await Promise.all([
      user.client.listAll<NamedBitrixItem>(
        'booking.v1.resource.list',
        {},
        {
          pick: (r) => (r as { resource?: NamedBitrixItem[] }).resource ?? [],
        },
      ),
      user.client.listAll<NamedBitrixItem>(
        'crm.category.list',
        { entityTypeId: 2 },
        {
          pick: (r) => (r as { categories?: NamedBitrixItem[] }).categories ?? [],
        },
      ),
      this.departments(user),
      this.users(user),
    ]);
    const named = (rows: NamedBitrixItem[]) =>
      rows.map((r) => ({ id: Number(r.id), name: r.name })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    return {
      users,
      resources: named(resources),
      categories: named(categories),
      departments: departments.items,
      departmentsAvailable: departments.available,
    };
  }

  private async users(user: B24UserContext): Promise<NamedBitrixItem[]> {
    const [members, admins] = await Promise.all([
      this.prisma.workGroupMember.findMany({
        where: { kind: 'USER', group: { portalId: user.portal.id, archivedAt: null } },
        select: { bitrixId: true },
      }),
      this.prisma.appAdmin.findMany({ where: { portalId: user.portal.id, kind: 'USER' }, select: { bitrixId: true } }),
    ]);
    const ids = [...new Set([...members, ...admins].map((m) => m.bitrixId))];
    if (!ids.length) return [];
    const rows = await user.client.listAll<{ ID: string; NAME?: string; LAST_NAME?: string }>('user.get', {
      FILTER: { ID: ids },
    });
    return rows.map((r) => ({ id: Number(r.ID), name: fullName(r) }));
  }

  /**
   * Сотрудники для выбора участников: `q` — поиск по имени, должности, названию отдела
   * (`user.search`, первые 50); `departmentId` — все активные сотрудники отдела (без вложенных).
   * Уволенные и внешние (экстранет, e-mail) не возвращаются.
   */
  async employees(user: B24UserContext, query: unknown): Promise<EmployeeDto[]> {
    const parsed = employeeQuery.safeParse(query);
    if (!parsed.success)
      throw new BadRequestException({
        code: 'INVALID_EMPLOYEE_QUERY',
        message: 'Укажите строку поиска (от 2 символов) или отдел',
      });
    const { q, departmentId } = parsed.data;
    const rows =
      q !== undefined
        ? ((await user.client.call<BitrixUser[]>('user.search', { FILTER: { FIND: q } })).result ?? [])
        : await user.client.listAll<BitrixUser>('user.get', { FILTER: { UF_DEPARTMENT: departmentId, ACTIVE: true } });
    return rows
      .filter((u) => u.ACTIVE !== false && u.ACTIVE !== 'N' && (u.USER_TYPE ?? 'employee') === 'employee')
      .map((u) => ({
        id: Number(u.ID),
        name: fullName(u),
        position: u.WORK_POSITION ?? '',
        departmentIds: [u.UF_DEPARTMENT ?? []].flat().map(Number).filter(Number.isSafeInteger),
      }))
      .filter((u) => Number.isSafeInteger(u.id) && u.id > 0)
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }

  private async departments(user: B24UserContext) {
    try {
      const rows = await user.client.listAll<{ ID: string; NAME: string; PARENT?: string | null }>('department.get');
      const items: DepartmentItem[] = rows.map((r) => ({
        id: Number(r.ID),
        name: r.NAME,
        parentId: r.PARENT ? Number(r.PARENT) : null,
      }));
      return { items, available: true };
    } catch (err) {
      // Отсутствие scope не должно мешать назначать сотрудников поимённо.
      if (
        err instanceof Bitrix24Error &&
        ['insufficient_scope', 'ACCESS_DENIED', 'ERROR_METHOD_NOT_FOUND'].includes(err.code)
      )
        return { items: [], available: false };
      throw err;
    }
  }
}
