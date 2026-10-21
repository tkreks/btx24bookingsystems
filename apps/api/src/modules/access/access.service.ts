import { Injectable, Logger } from '@nestjs/common';
import { effectivePermissions, higherRole, PERMISSIONS, type GroupOptionsDto, type GroupRole, type MyGroupDto, type Permission } from '@btx24/shared';
import type { WorkGroup } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { Bitrix24Error } from '../bitrix24/rest/errors.js';

const DEPARTMENTS_TTL_MS = 10 * 60_000;

export interface GroupAccess {
  group: WorkGroup & { resourceIds: number[] };
  role: GroupRole | 'APP_ADMIN';
  permissions: Permission[];
}

export interface UserAccess {
  /** Администратор приложения: постоянный или по временному паролю (см. `tempAdminUntil`). */
  isAppAdmin: boolean;
  /** Доступ по временному паролю — до этого момента; null — постоянный админ или не админ. */
  tempAdminUntil: Date | null;
  groups: GroupAccess[];
}

/**
 * Права пользователя в группах (ADR 0005). Единственное место, где решается «что можно»:
 * контроллеры спрашивают здесь, интерфейс лишь скрывает недоступное.
 */
@Injectable()
export class AccessService {
  private readonly logger = new Logger(AccessService.name);
  /** portalId → (отдел → родитель); строится из department.get, живёт 10 минут. */
  private readonly deptParents = new Map<string, { parents: Map<number, number | null>; expiresAt: number }>();

  constructor(private readonly prisma: PrismaService) {}

  async resolve(user: B24UserContext): Promise<UserAccess> {
    const depts = await this.departmentsWithAncestors(user);
    const matches = (m: { kind: string; bitrixId: number }) => (m.kind === 'USER' ? m.bitrixId === user.userId : depts.has(m.bitrixId));

    const admins = await this.prisma.appAdmin.findMany({ where: { portalId: user.portal.id } });
    const permanentAdmin = user.isAdmin || admins.some(matches);
    // Временный пароль к настройкам: активированный этим сотрудником, не отозван и не истёк.
    const grant = permanentAdmin
      ? null
      : await this.prisma.settingsAccessCode.findFirst({
          where: { portalId: user.portal.id, usedByUserId: user.userId, revokedAt: null, expiresAt: { gt: new Date() } },
          orderBy: { expiresAt: 'desc' },
        });
    const isAppAdmin = permanentAdmin || grant !== null;

    const groups = await this.prisma.workGroup.findMany({
      where: { portalId: user.portal.id, archivedAt: null },
      include: { resources: true, members: true },
      orderBy: [{ sort: 'asc' }, { name: 'asc' }],
    });

    const out: GroupAccess[] = [];
    for (const g of groups) {
      const features = Array.isArray(g.features) ? (g.features as string[]) : [];
      const { resources, members, ...rest } = g;
      const group = { ...rest, resourceIds: resources.map((r) => r.resourceId) };
      if (isAppAdmin) {
        out.push({ group, role: 'APP_ADMIN', permissions: [...PERMISSIONS].filter((p) => effectivePermissions('GROUP_ADMIN', features).includes(p)) });
        continue;
      }
      // Личная роль важнее роли отдела: так отделу можно дать «Менеджера», а отдельному
      // сотруднику — только «Просмотр». Среди отделов — старшая роль.
      const personal = members.find((m) => m.kind === 'USER' && m.bitrixId === user.userId);
      let role: GroupRole | null = personal ? (personal.role as GroupRole) : null;
      if (!personal)
        for (const m of members) if (m.kind === 'DEPARTMENT' && matches(m)) role = higherRole(role, m.role as GroupRole);
      if (role) out.push({ group, role, permissions: effectivePermissions(role, features) });
    }
    return { isAppAdmin, tempAdminUntil: grant?.expiresAt ?? null, groups: out };
  }

  /** Группа, доступная пользователю, с нужным правом — иначе null. */
  pick(access: UserAccess, groupId: string | undefined, permission: Permission): GroupAccess | null {
    const candidates = access.groups.filter((g) => g.permissions.includes(permission));
    return (groupId ? candidates.find((g) => g.group.id === groupId) : candidates[0]) ?? null;
  }

  toDto(g: GroupAccess): MyGroupDto {
    return {
      id: g.group.id,
      name: g.group.name,
      role: g.role,
      permissions: g.permissions,
      resourceIds: g.group.resourceIds,
      dealCategoryId: g.group.dealCategoryId,
      bookingMode: g.group.bookingMode,
      techWindowMinutes: g.group.techWindowMinutes,
      views: (g.group.options as GroupOptionsDto | null)?.views ?? { desktop: '', mobile: '' },
    };
  }

  /**
   * Отделы сотрудника вместе со всеми вышестоящими: участник-отдел включает вложенные отделы.
   * Без права `department` (department.get недоступен) — только прямые отделы.
   */
  private async departmentsWithAncestors(user: B24UserContext): Promise<Set<number>> {
    const result = new Set(user.departmentIds);
    if (!user.departmentIds.length) return result;
    const parents = await this.departmentTree(user);
    for (const start of user.departmentIds) {
      let cur = parents.get(start) ?? null;
      for (let guard = 0; cur !== null && guard < 100 && !result.has(cur); guard++) {
        result.add(cur);
        cur = parents.get(cur) ?? null;
      }
    }
    return result;
  }

  private async departmentTree(user: B24UserContext): Promise<Map<number, number | null>> {
    const cached = this.deptParents.get(user.portal.id);
    if (cached && cached.expiresAt > Date.now()) return cached.parents;
    const parents = new Map<number, number | null>();
    try {
      const rows = await user.client.listAll<{ ID: string; PARENT?: string | null }>('department.get');
      for (const d of rows) parents.set(Number(d.ID), d.PARENT ? Number(d.PARENT) : null);
    } catch (err) {
      if (!(err instanceof Bitrix24Error)) throw err;
      this.logger.warn(`department.get unavailable (${err.code}) — matching direct departments only`);
    }
    this.deptParents.set(user.portal.id, { parents, expiresAt: Date.now() + DEPARTMENTS_TTL_MS });
    return parents;
  }
}
