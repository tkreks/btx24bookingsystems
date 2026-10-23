import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AppSettingsDto, GroupDto, GroupFeature, GroupOptionsDto, GroupRole, GroupSettingsDto, MemberKind } from '@btx24/shared';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { appSettingsSchema, groupSettingsSchema } from './groups.schemas.js';

type Settings = GroupSettingsDto;

/** Настройки групп и приложения — данные нашей БД (в Битрикс24 ничего не пишется). */
@Injectable()
export class GroupsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(portalId: string): Promise<GroupDto[]> {
    const groups = await this.prisma.workGroup.findMany({
      where: { portalId, archivedAt: null },
      include: { resources: true, members: true },
      orderBy: [{ sort: 'asc' }, { name: 'asc' }],
    });
    return groups.map((g) => ({
      id: g.id,
      sort: g.sort,
      name: g.name,
      dealCategoryId: g.dealCategoryId,
      resourceIds: g.resources.map((r) => r.resourceId).sort((a, b) => a - b),
      bookingMode: g.bookingMode,
      durationMinutes: g.durationMinutes,
      checkInTime: g.checkInTime,
      checkOutTime: g.checkOutTime,
      defaultNights: g.defaultNights,
      techWindowMinutes: g.techWindowMinutes,
      features: (Array.isArray(g.features) ? g.features : []) as GroupFeature[],
      members: g.members.map((m) => ({ kind: m.kind as MemberKind, bitrixId: m.bitrixId, role: m.role as GroupRole })),
      options: (g.options ?? null) as GroupOptionsDto | null,
    }));
  }

  async create(portalId: string, body: unknown): Promise<GroupDto> {
    const s = this.parse(groupSettingsSchema, body);
    await this.checkTemplates(portalId, s);
    const sort = (await this.prisma.workGroup.count({ where: { portalId, archivedAt: null } })) * 10;
    const g = await this.prisma.workGroup.create({
      data: { portalId, sort, ...this.columns(s), resources: { create: unique(s.resourceIds).map((resourceId) => ({ resourceId })) }, members: { create: dedupeMembers(s.members) } },
    });
    return this.one(portalId, g.id);
  }

  /** Полная замена настроек, ресурсов и участников — одной транзакцией. */
  async update(portalId: string, id: string, body: unknown): Promise<GroupDto> {
    const s = this.parse(groupSettingsSchema, body);
    await this.ensure(portalId, id);
    await this.checkTemplates(portalId, s);
    await this.prisma.$transaction([
      this.prisma.workGroup.update({ where: { id }, data: this.columns(s) }),
      this.prisma.workGroupResource.deleteMany({ where: { groupId: id } }),
      this.prisma.workGroupResource.createMany({ data: unique(s.resourceIds).map((resourceId) => ({ groupId: id, resourceId })) }),
      this.prisma.workGroupMember.deleteMany({ where: { groupId: id } }),
      this.prisma.workGroupMember.createMany({ data: dedupeMembers(s.members).map((m) => ({ ...m, groupId: id })) }),
    ]);
    return this.one(portalId, id);
  }

  /** Группа не удаляется физически — архивируется (история, будущие ссылки из броней). */
  async archive(portalId: string, id: string): Promise<void> {
    await this.ensure(portalId, id);
    await this.prisma.workGroup.update({ where: { id }, data: { archivedAt: new Date() } });
  }

  async settings(portalId: string): Promise<AppSettingsDto> {
    const [s, admins, appUsers, heads] = await Promise.all([
      this.prisma.portalSettings.findUnique({ where: { portalId } }),
      this.prisma.appAdmin.findMany({ where: { portalId } }),
      this.prisma.appUser.findMany({ where: { portalId } }),
      this.prisma.appHead.findMany({ where: { portalId } }),
    ]);
    return {
      dialogMetadataEnabled: s?.dialogMetadataEnabled ?? false,
      dialogTextsEnabled: s?.dialogTextsEnabled ?? false,
      removeWazzupEmail: s?.removeWazzupEmail ?? false,
      createInBitrix: s?.createInBitrix ?? false,
      createGrantedAt: s?.createGrantedAt?.toISOString() ?? null,
      updateDealFields: s?.updateDealFields ?? false,
      admins: admins.map((a) => ({ kind: a.kind as MemberKind, bitrixId: a.bitrixId })),
      appUsers: appUsers.map((a) => ({ kind: a.kind as MemberKind, bitrixId: a.bitrixId })),
      heads: heads.map((a) => ({ kind: a.kind as MemberKind, bitrixId: a.bitrixId })),
    };
  }

  async saveSettings(portalId: string, userId: number, body: unknown): Promise<AppSettingsDto> {
    const s = this.parse(appSettingsSchema, body);
    const prev = await this.prisma.portalSettings.findUnique({ where: { portalId } });
    // Кто и когда включил создание в Битрикс24 — запоминается при включении.
    const grant =
      s.createInBitrix === undefined || s.createInBitrix === (prev?.createInBitrix ?? false)
        ? {}
        : s.createInBitrix
          ? { createInBitrix: true, createGrantedByUserId: userId, createGrantedAt: new Date() }
          : { createInBitrix: false };
    const flags = {
      dialogMetadataEnabled: s.dialogMetadataEnabled,
      dialogTextsEnabled: s.dialogTextsEnabled,
      removeWazzupEmail: s.removeWazzupEmail,
      ...grant,
      ...(s.updateDealFields === undefined ? {} : { updateDealFields: s.updateDealFields }),
      updatedByUserId: userId,
    };
    const admins = [...new Map(s.admins.map((a) => [`${a.kind}:${a.bitrixId}`, a])).values()];
    const appUsers = s.appUsers && [...new Map(s.appUsers.map((a) => [`${a.kind}:${a.bitrixId}`, a])).values()];
    const heads = s.heads && [...new Map(s.heads.map((a) => [`${a.kind}:${a.bitrixId}`, a])).values()];
    await this.prisma.$transaction([
      this.prisma.portalSettings.upsert({ where: { portalId }, create: { portalId, ...flags }, update: flags }),
      this.prisma.appAdmin.deleteMany({ where: { portalId } }),
      this.prisma.appAdmin.createMany({ data: admins.map((a) => ({ portalId, ...a })) }),
      ...(appUsers
        ? [this.prisma.appUser.deleteMany({ where: { portalId } }), this.prisma.appUser.createMany({ data: appUsers.map((a) => ({ portalId, ...a })) })]
        : []),
      ...(heads ? [this.prisma.appHead.deleteMany({ where: { portalId } }), this.prisma.appHead.createMany({ data: heads.map((a) => ({ portalId, ...a })) })] : []),
    ]);
    return this.settings(portalId);
  }
  /** Шаблоны предоплаты и доплаты — системные шаблоны оплаты этого портала. */
  private async checkTemplates(portalId: string, s: Settings): Promise<void> {
    const p = s.options?.payments;
    const ids = [...new Set([p?.prepaymentTemplateId, p?.surchargeTemplateId].filter((x): x is string => !!x))];
    if (ids.length) {
      const found = await this.prisma.messageTemplate.count({ where: { portalId, id: { in: ids }, purpose: 'payment', shared: true } });
      if (found !== ids.length)
        throw new BadRequestException({ code: 'INVALID_PAYMENT_TEMPLATE', message: 'Шаблон сообщения об оплате не найден — выберите системный шаблон оплаты' });
    }
    const auto = [...new Set((s.options?.autoMessages ?? []).map((r) => r.templateId))];
    if (auto.length) {
      const found = await this.prisma.messageTemplate.count({ where: { portalId, id: { in: auto }, purpose: 'auto', shared: true } });
      if (found !== auto.length)
        throw new BadRequestException({ code: 'INVALID_AUTO_TEMPLATE', message: 'Шаблон рассылки не найден — выберите системный шаблон с назначением «Автоматическая рассылка»' });
    }
  }

  private columns(s: Settings): Omit<Prisma.WorkGroupUncheckedCreateInput, 'portalId'> {
    return {
      name: s.name,
      dealCategoryId: s.dealCategoryId,
      bookingMode: s.bookingMode,
      durationMinutes: s.durationMinutes,
      checkInTime: s.checkInTime,
      checkOutTime: s.checkOutTime,
      defaultNights: s.defaultNights,
      techWindowMinutes: s.techWindowMinutes,
      features: unique(s.features),
      ...(s.options === undefined ? {} : { options: s.options === null ? Prisma.DbNull : (s.options as unknown as Prisma.InputJsonValue) }),
    };
  }

  private async one(portalId: string, id: string): Promise<GroupDto> {
    const g = (await this.list(portalId)).find((x) => x.id === id);
    if (!g) throw new NotFoundException({ code: 'GROUP_NOT_FOUND', message: 'Группа не найдена' });
    return g;
  }

  private async ensure(portalId: string, id: string) {
    const g = await this.prisma.workGroup.findFirst({ where: { id, portalId, archivedAt: null } });
    if (!g) throw new NotFoundException({ code: 'GROUP_NOT_FOUND', message: 'Группа не найдена' });
  }

  private parse<T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, body: unknown): T {
    const r = schema.safeParse(body);
    if (r.success) return r.data;
    throw new BadRequestException({ code: 'VALIDATION_ERROR', message: r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
  }
}

const unique = <T>(xs: T[]) => [...new Set(xs)];

function dedupeMembers<T extends { kind: string; bitrixId: number; role: string }>(members: T[]) {
  // Повтор одного участника — оставляем последнюю указанную роль.
  return [...new Map(members.map((m) => [`${m.kind}:${m.bitrixId}`, { kind: m.kind as MemberKind, bitrixId: m.bitrixId, role: m.role as GroupRole }])).values()];
}
