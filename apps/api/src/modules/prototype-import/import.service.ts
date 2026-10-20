import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { hashPassword } from '../external-users/password.js';
import { groupOptionsSchema } from '../groups/groups.schemas.js';
import { mapPrototype } from './prototype-mapper.js';

export interface ImportSummary {
  applied: boolean;
  groups: { legacyId: string; name: string; action: 'create' | 'update'; resources: number; dealFields: number }[];
  externalUsers: { login: string; action: 'create' | 'update'; role: string; allGroups: boolean; groups: number }[];
  removeWazzupEmail: boolean;
  warnings: string[];
}

/**
 * Импорт настроек прототипа. Повторный запуск обновляет то же самое (по legacyId / login), не
 * дублирует. Участников групп НЕ трогает: в прототипе их не было (доступ имели все сотрудники).
 * Без `apply` — только отчёт, без записи.
 */
@Injectable()
export class PrototypeImportService {
  constructor(private readonly prisma: PrismaService) {}

  async run(portalId: string, raw: unknown, apply: boolean): Promise<ImportSummary> {
    const m = mapPrototype(raw);
    for (const g of m.groups) groupOptionsSchema.parse(g.options);

    const existingGroups = await this.prisma.workGroup.findMany({ where: { portalId, legacyId: { in: m.groups.map((g) => g.legacyId) } } });
    const existingUsers = await this.prisma.externalUser.findMany({ where: { portalId, login: { in: m.externalUsers.map((u) => u.login) } } });
    const summary: ImportSummary = {
      applied: apply,
      groups: m.groups.map((g) => ({ legacyId: g.legacyId, name: g.name, action: existingGroups.some((e) => e.legacyId === g.legacyId) ? 'update' : 'create', resources: g.resourceIds.length, dealFields: g.options.dealFields.length })),
      externalUsers: m.externalUsers.map((u) => ({ login: u.login, action: existingUsers.some((e) => e.login === u.login) ? 'update' : 'create', role: u.role, allGroups: u.allGroups, groups: u.legacyGroupIds.length })),
      removeWazzupEmail: m.removeWazzupEmail,
      warnings: m.warnings,
    };
    if (!apply) return summary;

    const hashes = new Map<string, string>();
    for (const u of m.externalUsers) hashes.set(u.login, await hashPassword(u.password));

    await this.prisma.$transaction(async (tx) => {
      const idByLegacy = new Map<string, string>();
      for (const g of m.groups) {
        const columns = {
          name: g.name,
          sort: g.sort,
          dealCategoryId: g.dealCategoryId,
          bookingMode: g.bookingMode,
          durationMinutes: g.durationMinutes,
          checkInTime: g.checkInTime,
          checkOutTime: g.checkOutTime,
          defaultNights: g.defaultNights,
          techWindowMinutes: g.techWindowMinutes,
          options: g.options as unknown as Prisma.InputJsonValue,
          archivedAt: null,
        };
        const saved = await tx.workGroup.upsert({
          where: { portalId_legacyId: { portalId, legacyId: g.legacyId } },
          create: { portalId, legacyId: g.legacyId, features: m.features, ...columns },
          update: columns,
        });
        idByLegacy.set(g.legacyId, saved.id);
        await tx.workGroupResource.deleteMany({ where: { groupId: saved.id } });
        await tx.workGroupResource.createMany({ data: g.resourceIds.map((resourceId) => ({ groupId: saved.id, resourceId })) });
      }
      for (const u of m.externalUsers) {
        const data = { passwordHash: hashes.get(u.login)!, role: u.role, allGroups: u.allGroups, visibleFields: u.visibleFields ?? undefined, disabledAt: null };
        const saved = await tx.externalUser.upsert({ where: { portalId_login: { portalId, login: u.login } }, create: { portalId, login: u.login, ...data }, update: data });
        await tx.externalUserGroup.deleteMany({ where: { externalUserId: saved.id } });
        await tx.externalUserGroup.createMany({ data: u.legacyGroupIds.map((lid) => ({ externalUserId: saved.id, groupId: idByLegacy.get(lid)! })) });
      }
      await tx.portalSettings.upsert({ where: { portalId }, create: { portalId, removeWazzupEmail: m.removeWazzupEmail }, update: { removeWazzupEmail: m.removeWazzupEmail } });
    });
    return summary;
  }
}
