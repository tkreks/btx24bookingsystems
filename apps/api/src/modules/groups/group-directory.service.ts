import { Injectable } from '@nestjs/common';
import type { GroupDirectoryDto, NamedBitrixItem } from '@btx24/shared';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { Bitrix24Error } from '../bitrix24/rest/errors.js';

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
    return rows.map((r) => ({
      id: Number(r.ID),
      name: [r.NAME, r.LAST_NAME].filter(Boolean).join(' ') || `Сотрудник #${r.ID}`,
    }));
  }

  private async departments(user: B24UserContext) {
    try {
      const rows = await user.client.listAll<{ ID: string; NAME: string }>('department.get');
      return { items: rows.map((r) => ({ id: Number(r.ID), name: r.NAME })), available: true };
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
