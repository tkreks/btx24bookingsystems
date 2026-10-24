import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { CrmAccessService } from './crm-access.service.js';
import { callBindings, type CrmRow } from './crm-rows.js';

/** Отбор сделок копии — то, что дашборд раньше передавал фильтром crm.deal.list. */
export interface DealQuery {
  ids?: number[];
  createdFrom?: Date;
  createdTo?: Date;
  categoryIds?: number[];
  assignedById?: number;
  contactIds?: number[];
  /** Без проигранных (`!STAGE_SEMANTIC_ID: F`). */
  notLost?: boolean;
}

/** Готовность копии запоминаем ненадолго — чтобы не спрашивать базу на каждый блок. */
const READY_MS = 15_000;
/** Кандидатов за раз при отборе «последних N видимых». */
const SCAN = 200;

/**
 * Чтение копии CRM для дашборда (ADR 0013). Каждая выборка проходит `CrmAccessService`: сотрудник
 * видит только то, что видит в CRM своим токеном. Звонок виден, если видна хоть одна его привязка
 * (владелец или клиент звонка) — как дело в CRM.
 */
@Injectable()
export class CrmMirrorReader {
  private readonly readyCache = new Map<string, { at: number; fields: string[] | null; done: boolean }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CrmAccessService,
  ) {}

  /** Первичная загрузка вида завершена (и у сделок в копии есть все `fields`). */
  async ready(portalId: string, kind: 'deal' | 'call', fields: string[] = []): Promise<boolean> {
    const key = `${portalId}|${kind}`;
    let hit = this.readyCache.get(key);
    if (!hit || Date.now() - hit.at > READY_MS) {
      const st = await this.prisma.crmSyncState.findUnique({ where: { portalId_kind: { portalId, kind } } });
      hit = { at: Date.now(), done: !!st?.backfillDoneAt, fields: st?.fieldsKey ? st.fieldsKey.split(',') : null };
      this.readyCache.set(key, hit);
    }
    return hit.done && (kind !== 'deal' || fields.every((f) => hit.fields?.includes(f)));
  }

  // ---------- Сделки ----------

  /** Видимые сотруднику сделки по отбору, новые сверху; `max` — после проверки прав. */
  async deals(user: B24UserContext, q: DealQuery, max = 5000): Promise<CrmRow[]> {
    if (q.ids && !q.ids.length) return [];
    if (q.contactIds && !q.contactIds.length) return [];
    const where: Prisma.CrmDealWhereInput = {
      portalId: user.portal.id,
      deletedAt: null,
      ...(q.ids ? { dealId: { in: q.ids } } : {}),
      ...(q.createdFrom || q.createdTo ? { createdAt: { ...(q.createdFrom ? { gte: q.createdFrom } : {}), ...(q.createdTo ? { lt: q.createdTo } : {}) } } : {}),
      ...(q.categoryIds?.length ? { categoryId: { in: q.categoryIds } } : {}),
      ...(q.assignedById !== undefined ? { assignedById: q.assignedById } : {}),
      ...(q.contactIds ? { contactId: { in: q.contactIds } } : {}),
      ...(q.notLost ? { OR: [{ stageSemantic: null }, { stageSemantic: { not: 'F' } }] } : {}),
    };
    const out: CrmRow[] = [];
    for (let skip = 0; out.length < max; skip += SCAN * 5) {
      const rows = await this.prisma.crmDeal.findMany({ where, orderBy: [{ createdAt: 'desc' }, { dealId: 'desc' }], skip, take: SCAN * 5, select: { dealId: true, row: true } });
      const ok = await this.access.visible(user, 2, rows.map((r) => r.dealId));
      out.push(...rows.filter((r) => ok.has(r.dealId)).map((r) => r.row as CrmRow));
      if (rows.length < SCAN * 5) break;
    }
    return out.slice(0, max);
  }

  /** Сделки по номерам: какие есть в копии (видимые) и каких в копии ещё нет (`missing` — спросить портал). */
  async dealsByIds(user: B24UserContext, ids: number[]): Promise<{ rows: CrmRow[]; missing: number[] }> {
    const unique = [...new Set(ids.filter((x) => x > 0))];
    if (!unique.length) return { rows: [], missing: [] };
    const rows = await this.prisma.crmDeal.findMany({ where: { portalId: user.portal.id, dealId: { in: unique } }, select: { dealId: true, row: true, deletedAt: true } });
    const have = new Set(rows.map((r) => r.dealId));
    const live = rows.filter((r) => !r.deletedAt);
    const ok = await this.access.visible(user, 2, live.map((r) => r.dealId));
    return { rows: live.filter((r) => ok.has(r.dealId)).map((r) => r.row as CrmRow), missing: unique.filter((id) => !have.has(id)) };
  }

  // ---------- Звонки ----------

  /** Звонки с `from` (по `to`), видимые сотруднику; `responsibleId` — только его. */
  async calls(user: B24UserContext, q: { from?: Date; to?: Date; responsibleId?: number; desc?: boolean }, max: number): Promise<{ rows: CrmRow[]; truncated: boolean }> {
    const where: Prisma.CrmCallWhereInput = {
      portalId: user.portal.id,
      deletedAt: null,
      ...(q.from || q.to ? { startAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lt: q.to } : {}) } } : {}),
      ...(q.responsibleId !== undefined ? { responsibleId: q.responsibleId } : {}),
    };
    const out: CrmRow[] = [];
    let truncated = false;
    for (let skip = 0; ; skip += SCAN * 5) {
      const rows = await this.prisma.crmCall.findMany({
        where,
        orderBy: [{ startAt: q.desc ? 'desc' : 'asc' }, { activityId: q.desc ? 'desc' : 'asc' }],
        skip,
        take: SCAN * 5,
        select: { row: true },
      });
      const bindings = rows.map((r) => callBindings(r.row as CrmRow));
      const ok = await this.access.visibleMany(user, bindings.flat());
      out.push(...rows.filter((_, i) => bindings[i].some((b) => ok.get(b.typeId)?.has(b.id))).map((r) => r.row as CrmRow));
      if (out.length >= max) {
        truncated = true;
        break;
      }
      if (rows.length < SCAN * 5) break;
    }
    return { rows: out.slice(0, max), truncated };
  }

  /** Линия портала и сотрудник звонков (статистика телефонии в копии). */
  async callLines(portalId: string, activityIds: number[]): Promise<Map<number, { phone: string | null; userId: number | null }>> {
    const ids = [...new Set(activityIds.filter((x) => x > 0))];
    if (!ids.length) return new Map();
    const rows = await this.prisma.crmCall.findMany({ where: { portalId, activityId: { in: ids }, statsAt: { not: null } }, select: { activityId: true, portalNumber: true, portalUserId: true } });
    return new Map(rows.map((r) => [r.activityId, { phone: r.portalNumber, userId: r.portalUserId }]));
  }

  // ---------- Названия и люди ----------

  /** Названия видимых сотруднику записей: ключ `тип:ID` (2 — сделки, 1/3/4 — лиды, контакты, компании). */
  async titles(user: B24UserContext, refs: { typeId: number; id: number }[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const ok = await this.access.visibleMany(user, refs);
    const deals = [...(ok.get(2) ?? [])];
    if (deals.length)
      for (const d of await this.prisma.crmDeal.findMany({ where: { portalId: user.portal.id, dealId: { in: deals }, deletedAt: null }, select: { dealId: true, row: true } }))
        out.set(`2:${d.dealId}`, String((d.row as CrmRow).TITLE ?? '') || `Сделка #${d.dealId}`);
    for (const typeId of [1, 3, 4]) {
      const ids = [...(ok.get(typeId) ?? [])];
      if (!ids.length) continue;
      for (const e of await this.prisma.crmEntity.findMany({ where: { portalId: user.portal.id, entityTypeId: typeId, entityId: { in: ids }, deletedAt: null }, select: { entityId: true, title: true } }))
        out.set(`${typeId}:${e.entityId}`, e.title);
    }
    return out;
  }

  /** Имена и фото видимых сотруднику контактов; `missing` — контактов ещё нет в копии (спросить портал). */
  async contacts(user: B24UserContext, ids: number[]): Promise<{ found: Map<number, { name: string; photo: string | null }>; missing: number[] }> {
    const unique = [...new Set(ids.filter((x) => x > 0))];
    if (!unique.length) return { found: new Map(), missing: [] };
    const rows = await this.prisma.crmEntity.findMany({ where: { portalId: user.portal.id, entityTypeId: 3, entityId: { in: unique } }, select: { entityId: true, title: true, photo: true, deletedAt: true } });
    const have = new Set(rows.map((r) => r.entityId));
    const live = rows.filter((r) => !r.deletedAt);
    const ok = await this.access.visible(user, 3, live.map((r) => r.entityId));
    return {
      found: new Map(live.filter((r) => ok.has(r.entityId)).map((r) => [r.entityId, { name: r.title, photo: r.photo }])),
      missing: unique.filter((id) => !have.has(id)),
    };
  }

  /** Сотрудники портала: имя и аватарка (не тайна внутри портала — без проверки прав). */
  async employees(portalId: string, ids: number[]): Promise<Map<number, { name: string; photo: string | null }>> {
    const unique = [...new Set(ids.filter((x) => x > 0))];
    if (!unique.length) return new Map();
    const rows = await this.prisma.portalEmployee.findMany({ where: { portalId, userId: { in: unique } }, select: { userId: true, name: true, photo: true } });
    return new Map(rows.map((r) => [r.userId, { name: r.name, photo: r.photo }]));
  }

  /** Сотрудники в копии есть (первая загрузка прошла). */
  async hasEmployees(portalId: string): Promise<boolean> {
    return !!(await this.prisma.crmSyncState.findUnique({ where: { portalId_kind: { portalId, kind: 'employee' } } }))?.backfillDoneAt;
  }

  /** Названия ресурсов бронирования (зеркало `Resource`, ведёт сверка броней). */
  async resourceNames(portalId: string): Promise<Map<number, string>> {
    const rows = await this.prisma.resource.findMany({ where: { portalId }, select: { resourceId: true, name: true } });
    return new Map(rows.map((r) => [r.resourceId, r.name || `Ресурс ${r.resourceId}`]));
  }
}
