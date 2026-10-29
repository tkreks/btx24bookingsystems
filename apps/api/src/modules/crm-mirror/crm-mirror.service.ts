import { contactActor, contactBusinessChanges, contactFingerprint } from './contact-changes.js';
import { Injectable, Logger } from '@nestjs/common';
import type { Portal, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { photoUrl } from '../bitrix24/rest/photo-url.js';
import type { Bitrix24RestClient } from '../bitrix24/rest/rest-client.js';
import { DealFieldMapService } from '../bookings/deal-field-map.service.js';
import {
  CALL_FIELDS,
  CALL_FILTER,
  callColumns,
  callEntityRefs,
  dealColumns,
  dealSelect,
  ENTITY_SPECS,
  ENTITY_TYPES,
  entityColumns,
  num,
  type CrmRow,
  type EntityTypeId,
} from './crm-rows.js';

export type MirrorKind = 'deal' | 'call' | 'entity' | 'employee' | 'contact' | 'contact_changes' | 'contact_presence';
/** Звонки в копии — за столько дней назад (период дашборда — до 92 дней, плюс запас на перезвоны). */
export const CALL_HISTORY_DAYS = 120;
/** Страниц по 50 за один проход первичной загрузки (остальное — в следующий проход). */
const BACKFILL_PAGES = 20;
/** Запас по времени для изменений «с момента»: часы портала и сервера расходятся. */
const OVERLAP_MS = 2 * 60_000;
const PAGE = 50;
const DAY_MS = 86_400_000;

const json = (r: CrmRow) => r as Prisma.InputJsonValue;
const chunks = <T>(list: T[], size = PAGE): T[][] => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));

/**
 * Копия CRM для дашборда (ADR 0013): сделки, звонки, лиды/контакты/компании, сотрудники. Пишет только
 * worker, токеном приложения (`PortalService.clientFor`): копия общая на портал и прав не даёт —
 * видимость каждому сотруднику проверяет `CrmAccessService` его токеном. Всё здесь идемпотентно:
 * повтор события или прохода перезаписывает ту же строку.
 */
@Injectable()
export class CrmMirrorService {
  private readonly logger = new Logger(CrmMirrorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fieldMap: DealFieldMapService,
  ) {}

  async state(portalId: string, kind: MirrorKind) {
    return this.prisma.crmSyncState.upsert({ where: { portalId_kind: { portalId, kind } }, create: { portalId, kind }, update: {} });
  }

  private async setState(portalId: string, kind: MirrorKind, data: Prisma.CrmSyncStateUpdateInput) {
    await this.prisma.crmSyncState.update({ where: { portalId_kind: { portalId, kind } }, data });
  }

  /** Поля сделки в копии: базовые + все поля сопоставления (и найденные по названию). */
  async dealFields(portal: Portal, client: Bitrix24RestClient): Promise<string[]> {
    const [map, outcome] = await Promise.all([this.fieldMap.resolved(portal.id, client), this.fieldMap.outcome(portal.id, client)]);
    // COMMENTS — комментарий брони на экране внешнего просмотра (ADR 0021).
    return dealSelect([...Object.values(map), outcome.dealType, outcome.paidAmount, outcome.bookingEnd, 'COMMENTS']);
  }

  // ---------- Сделки ----------

  async saveDeals(portalId: string, rows: CrmRow[]): Promise<number[]> {
    const now = new Date();
    const valid = rows.map((r) => ({ r, c: dealColumns(r) })).filter((x) => x.c.dealId > 0);
    for (const part of chunks(valid))
      await this.prisma.$transaction(
        part.map(({ r, c }) =>
          this.prisma.crmDeal.upsert({
            where: { portalId_dealId: { portalId, dealId: c.dealId } },
            create: { portalId, ...c, row: json(r), syncedAt: now },
            update: { ...c, row: json(r), deletedAt: null, syncedAt: now },
          }),
        ),
      );
    return valid.map((x) => x.c.contactId ?? 0).filter((x) => x > 0);
  }

  /** Первичная загрузка всех сделок портала по возрастанию ID; true — загрузка завершена. */
  async backfillDeals(portal: Portal, client: Bitrix24RestClient): Promise<boolean> {
    const select = await this.dealFields(portal, client);
    const key = select.join(',');
    let st = await this.state(portal.id, 'deal');
    if (st.fieldsKey !== key) {
      // Сопоставление полей сменилось — нужных полей в копии нет: загрузить заново (since — с начала).
      await this.setState(portal.id, 'deal', { fieldsKey: key, backfillCursor: 0, backfillDoneAt: null, since: st.since ?? new Date() });
      st = await this.state(portal.id, 'deal');
    }
    if (st.backfillDoneAt) return true;
    let cursor = st.backfillCursor;
    for (let page = 0; page < BACKFILL_PAGES; page++) {
      const res = await client.call<CrmRow[]>('crm.deal.list', { order: { ID: 'ASC' }, filter: { '>ID': cursor }, select, start: -1 });
      const rows = Array.isArray(res.result) ? res.result : [];
      if (rows.length) {
        await this.fillEntities(portal, client, 3, await this.saveDeals(portal.id, rows));
        cursor = Math.max(cursor, ...rows.map((r) => num(r.ID) ?? 0));
      }
      if (rows.length < PAGE) {
        await this.setState(portal.id, 'deal', { backfillCursor: cursor, backfillDoneAt: new Date() });
        this.logger.log(`portal ${portal.id}: deals loaded (last ID ${cursor})`);
        return true;
      }
    }
    await this.setState(portal.id, 'deal', { backfillCursor: cursor });
    return false;
  }

  // ---------- Звонки ----------

  async saveCalls(portalId: string, rows: CrmRow[]): Promise<CrmRow[]> {
    const now = new Date();
    const calls = rows.map((r) => ({ r, c: callColumns(r) })).filter((x) => x.c.activityId > 0);
    for (const part of chunks(calls))
      await this.prisma.$transaction(
        part.map(({ r, c }) =>
          this.prisma.crmCall.upsert({
            where: { portalId_activityId: { portalId, activityId: c.activityId } },
            create: { portalId, ...c, row: json(r), syncedAt: now },
            update: { ...c, row: json(r), deletedAt: null, syncedAt: now },
          }),
        ),
      );
    return calls.map((x) => x.r);
  }

  /** Первичная загрузка звонков за `CALL_HISTORY_DAYS` дней; true — завершена. */
  async backfillCalls(portal: Portal, client: Bitrix24RestClient, now = new Date()): Promise<boolean> {
    const st = await this.state(portal.id, 'call');
    if (st.backfillDoneAt) return true;
    let cursor = st.backfillCursor;
    const since = new Date(now.getTime() - CALL_HISTORY_DAYS * DAY_MS).toISOString();
    for (let page = 0; page < BACKFILL_PAGES; page++) {
      const res = await client.call<CrmRow[]>('crm.activity.list', {
        order: { ID: 'ASC' },
        filter: { ...CALL_FILTER, '>=START_TIME': since, '>ID': cursor },
        select: [...CALL_FIELDS],
        start: -1,
      });
      const rows = Array.isArray(res.result) ? res.result : [];
      if (rows.length) {
        await this.afterCalls(portal, client, await this.saveCalls(portal.id, rows));
        cursor = Math.max(cursor, ...rows.map((r) => num(r.ID) ?? 0));
      }
      if (rows.length < PAGE) {
        await this.setState(portal.id, 'call', { backfillCursor: cursor, backfillDoneAt: new Date(), since: st.since ?? now });
        this.logger.log(`portal ${portal.id}: calls loaded (last ID ${cursor})`);
        return true;
      }
    }
    await this.setState(portal.id, 'call', { backfillCursor: cursor, since: st.since ?? now });
    return false;
  }

  /** Лиды/контакты/компании звонков — в копию (названия в журнале звонков). */
  private async afterCalls(portal: Portal, client: Bitrix24RestClient, rows: CrmRow[]) {
    const refs = rows.flatMap(callEntityRefs);
    for (const t of ENTITY_TYPES) await this.fillEntities(portal, client, t, refs.filter((r) => r.typeId === t).map((r) => r.id));
  }

  /**
   * Линия портала и сотрудник звонка из статистики телефонии — для звонков без неё. Статистика
   * появляется после окончания звонка; через сутки без неё больше не спрашиваем.
   */
  async fillCallStats(portal: Portal, client: Bitrix24RestClient, now = new Date()): Promise<void> {
    const pending = await this.prisma.crmCall.findMany({
      where: { portalId: portal.id, statsAt: null, deletedAt: null, startAt: { lt: new Date(now.getTime() - 60_000) } },
      select: { activityId: true, startAt: true },
      orderBy: { startAt: 'desc' },
      take: 200,
    });
    if (!pending.length) return;
    const ids = pending.map((p) => p.activityId);
    const rows = await client.listAll<{ CRM_ACTIVITY_ID?: string; PORTAL_NUMBER?: string; PORTAL_USER_ID?: string }>(
      'voximplant.statistic.get',
      { FILTER: { CRM_ACTIVITY_ID: ids }, SORT: 'ID', ORDER: 'DESC' },
      { max: 400 },
    );
    const seen = new Set<number>();
    for (const r of rows) {
      const id = Number(r.CRM_ACTIVITY_ID);
      if (!ids.includes(id) || seen.has(id)) continue;
      seen.add(id);
      const phone = String(r.PORTAL_NUMBER ?? '').trim();
      await this.prisma.crmCall.update({
        where: { portalId_activityId: { portalId: portal.id, activityId: id } },
        data: {
          portalNumber: /^\+?[\d ()-]{6,30}$/.test(phone) && phone.replace(/\D/g, '').length >= 6 ? phone.slice(0, 40) : null,
          portalUserId: num(r.PORTAL_USER_ID),
          statsAt: now,
        },
      });
    }
    const expired = pending.filter((p) => !seen.has(p.activityId) && now.getTime() - p.startAt.getTime() > DAY_MS).map((p) => p.activityId);
    if (expired.length) await this.prisma.crmCall.updateMany({ where: { portalId: portal.id, activityId: { in: expired } }, data: { statsAt: now } });
  }

  // ---------- Лиды, контакты, компании ----------

  async saveEntities(portal: Portal, typeId: number, rows: CrmRow[]): Promise<void> {
    if (typeId === 3) {
      for (const row of rows) await this.saveContact(portal, row, 'baseline');
      return;
    }
    const now = new Date();
    const items = rows.map((r) => ({ r, c: entityColumns(typeId, r, portal.domain) })).filter((x) => x.c.entityId > 0);
    for (const part of chunks(items))
      await this.prisma.$transaction(
        part.map(({ r, c }) =>
          this.prisma.crmEntity.upsert({
            where: { portalId_entityTypeId_entityId: { portalId: portal.id, entityTypeId: typeId, entityId: c.entityId } },
            create: { portalId: portal.id, entityTypeId: typeId, ...c, row: json(r), syncedAt: now },
            update: { ...c, row: json(r), deletedAt: null, syncedAt: now },
          }),
        ),
      );
  }

  /** Полная карточка контакта и её наблюдаемые изменения — атомарно, без записей в Битрикс24. */
  async saveContact(portal: Portal, row: CrmRow, observation: 'event' | 'poll' | 'baseline' = 'poll'): Promise<void> {
    const id = num(row.ID);
    if (!id) return;
    await this.prisma.$transaction(async tx => {
      const where = { portalId_entityTypeId_entityId: { portalId: portal.id, entityTypeId: 3, entityId: id } };
      const before = await tx.crmEntity.findUnique({ where });
      const old = before?.row && typeof before.row === 'object' && !Array.isArray(before.row) ? before.row as CrmRow : {};
      // Частичный ответ CRM не должен стирать уже сохранённые поля.
      const oldTime = Date.parse(String(old.DATE_MODIFY ?? ''));
      const nextTime = Date.parse(String(row.DATE_MODIFY ?? ''));
      if (before?.deletedAt && (!Number.isFinite(nextTime) || nextTime <= before.deletedAt.getTime())) return;
      if (Number.isFinite(oldTime) && Number.isFinite(nextTime) && nextTime < oldTime) return;
      const next = { ...old, ...row };
      const changes = Object.keys(next).filter(key => stableJson(old[key]) !== stableJson(next[key])).map(field => ({ field, before: old[field] ?? null, after: next[field] ?? null }));
      await tx.crmEntity.upsert({ where, create: { portalId: portal.id, entityTypeId: 3, ...entityColumns(3, next, portal.domain), row: json(next), syncedAt: new Date() }, update: { ...entityColumns(3, next, portal.domain), row: json(next), deletedAt: null, syncedAt: new Date() } });
      const actor = await contactActor(tx, portal.id, row);
      const actorName = actor.accountId ? `${actor.accountType === 'system_user' ? 'Системная учётная запись' : 'Битрикс24, последний редактор'}: ${actor.accountName ?? '#' + actor.accountId}` : 'Битрикс24, автор неизвестен';
      const versionChanged = Number.isFinite(oldTime) && Number.isFinite(nextTime) && nextTime > oldTime;
      const deviations = before && !before.deletedAt && observation !== 'baseline' && (observation === 'event' || versionChanged) ? contactBusinessChanges(changes, old) : [];
      if (changes.length || before?.deletedAt) await tx.actionLog.create({ data: {
        portalId: portal.id, actorKind: 'bitrix', actorName: actorName.slice(0, 255), userId: actor.accountId, action: before ? 'contact.changed_in_bitrix' : 'contact.imported',
        entityType: 'contact', entityId: String(id), summary: before ? `Контакт #${id}: изменения из Битрикс24` : `Контакт #${id}: сохранён из Битрикс24`, via: 'bitrix_sync',
        details: { changes, deviations, actor, modifiedById: num(row.MODIFY_BY_ID), modifiedAt: typeof row.DATE_MODIFY === 'string' ? row.DATE_MODIFY : null, restored: !!before?.deletedAt } as unknown as Prisma.InputJsonValue,
      } });
      if (deviations.length) await tx.contactAlert.createMany({ data: [{ portalId: portal.id, contactId: id, kind: 'change', changes: deviations as unknown as Prisma.InputJsonValue, actor: actor as unknown as Prisma.InputJsonValue, fingerprint: contactFingerprint(id, 'change', deviations, row.DATE_MODIFY ?? null) }], skipDuplicates: true });
    }, { isolationLevel: 'Serializable' });
  }

  async refreshContact(portal: Portal, client: Bitrix24RestClient, id: number, deleted = false, eventAt?: Date): Promise<void> {
    if (deleted) {
      await this.prisma.$transaction(async tx => {
        const where = { portalId_entityTypeId_entityId: { portalId: portal.id, entityTypeId: 3, entityId: id } };
        const before = await tx.crmEntity.findUnique({ where });
        if (before?.deletedAt) return;
        if (before) await tx.crmEntity.update({ where, data: { deletedAt: new Date() } });
        else await tx.crmEntity.create({ data: { portalId: portal.id, entityTypeId: 3, entityId: id, title: `Контакт #${id}`, row: {}, deletedAt: new Date(), syncedAt: new Date() } });
        const actor = await contactActor(tx, portal.id, {}, true);
        await tx.actionLog.create({ data: { portalId: portal.id, actorKind: 'bitrix', actorName: 'Битрикс24, автор удаления неизвестен', action: 'contact.deleted_in_bitrix', entityType: 'contact', entityId: String(id), summary: `Контакт #${id}: удалён в Битрикс24`, via: 'bitrix_sync', details: { before: before?.row ?? null, actor: actor as unknown as Prisma.InputJsonValue } } });
        await tx.contactAlert.createMany({ data: [{ portalId: portal.id, contactId: id, kind: 'deleted', changes: [], actor: actor as unknown as Prisma.InputJsonValue, fingerprint: contactFingerprint(id, 'deleted', [], before?.row ?? null) }], skipDuplicates: true });
      }, { isolationLevel: 'Serializable' });
      return;
    }
    if (eventAt) {
      const known = await this.prisma.crmEntity.findUnique({ where: { portalId_entityTypeId_entityId: { portalId: portal.id, entityTypeId: 3, entityId: id } }, select: { deletedAt: true } });
      if (known?.deletedAt && known.deletedAt >= eventAt) return;
    }
    const row = (await client.call<CrmRow>('crm.contact.get', { id })).result;
    if (!row?.ID) throw new Error('CRM contact unavailable');
    await this.saveContact(portal, row, 'event');
  }

  /** Начальная копия и периодические изменения — курсор ID сохраняется между проходами. */
  async syncContacts(portal: Portal, client: Bitrix24RestClient, initial: boolean, now = new Date()): Promise<void> {
    const kind = initial ? 'contact' : 'contact_changes';
    const state = await this.state(portal.id, kind);
    if (initial && state.backfillDoneAt) return;
    const since = state.since ?? new Date(now.getTime() - OVERLAP_MS);
    const until = state.backfillDoneAt ?? now;
    let cursor = state.backfillCursor;
    for (let page = 0; page < 2; page++) {
      const rows = (await client.call<CrmRow[]>('crm.contact.list', { order: { ID: 'ASC' }, filter: { '>ID': cursor, ...(!initial ? { '>=DATE_MODIFY': since.toISOString(), '<=DATE_MODIFY': until.toISOString() } : {}) }, select: ['*', 'UF_*', 'PHONE', 'EMAIL', 'WEB', 'IM'], start: -1 })).result;
      if (!Array.isArray(rows)) throw new Error('Invalid CRM contact list');
      for (const row of rows) await this.saveContact(portal, row, initial ? 'baseline' : 'poll');
      if (rows.length < PAGE) {
        await this.setState(portal.id, kind, initial ? { backfillCursor: cursor, backfillDoneAt: now, since } : { backfillCursor: 0, backfillDoneAt: null, since: new Date(until.getTime() - OVERLAP_MS) });
        return;
      }
      cursor = Math.max(cursor, ...rows.map(r => num(r.ID) ?? 0));
      await this.setState(portal.id, kind, { backfillCursor: cursor, since, ...(!initial ? { backfillDoneAt: until } : {}) });
    }
  }

  /** Сверяем наличие известных контактов: отсутствие в списке ещё не доказывает удаление. */
  async reconcileContacts(portal: Portal, client: Bitrix24RestClient): Promise<void> {
    const state = await this.state(portal.id, 'contact_presence');
    const known = await this.prisma.crmEntity.findMany({ where: { portalId: portal.id, entityTypeId: 3, deletedAt: null, entityId: { gt: state.backfillCursor } }, orderBy: { entityId: 'asc' }, take: 50, select: { entityId: true, row: true } });
    if (!known.length) { await this.setState(portal.id, 'contact_presence', { backfillCursor: 0, since: new Date() }); return; }
    const rows = (await client.call<CrmRow[]>('crm.contact.list', { filter: { '@ID': known.map(c => c.entityId) }, select: ['ID'] })).result;
    if (!Array.isArray(rows)) throw new Error('Invalid CRM contact presence response');
    const visible = new Set(rows.map(r => num(r.ID)));
    for (const contact of known.filter(c => !visible.has(c.entityId))) await this.prisma.$transaction(async tx => {
      const fingerprint = contactFingerprint(contact.entityId, 'missing', [], contact.row);
      const prior = await tx.contactAlert.findUnique({ where: { portalId_fingerprint: { portalId: portal.id, fingerprint } } });
      if (prior) return;
      const actor = await contactActor(tx, portal.id, {}, true);
      await tx.contactAlert.create({ data: { portalId: portal.id, contactId: contact.entityId, kind: 'missing', changes: [], actor: actor as unknown as Prisma.InputJsonValue, fingerprint } });
      await tx.actionLog.create({ data: { portalId: portal.id, actorKind: 'bitrix', actorName: 'Битрикс24', action: 'contact.missing_in_bitrix', entityType: 'contact', entityId: String(contact.entityId), summary: `Контакт #${contact.entityId}: не возвращён Битрикс24, требуется проверка доступности/удаления`, via: 'bitrix_sync', details: { deletionConfirmed: false, valuesPreserved: true } } });
    }, { isolationLevel: 'Serializable' });
    await this.setState(portal.id, 'contact_presence', { backfillCursor: known[known.length - 1].entityId, since: new Date() });
  }

  /** Загрузить в копию те из `ids`, которых в ней ещё нет. */
  async fillEntities(portal: Portal, client: Bitrix24RestClient, typeId: EntityTypeId, ids: number[]): Promise<void> {
    const unique = [...new Set(ids.filter((x) => x > 0))];
    if (!unique.length) return;
    const known = new Set(
      (await this.prisma.crmEntity.findMany({ where: { portalId: portal.id, entityTypeId: typeId, entityId: { in: unique } }, select: { entityId: true } })).map((e) => e.entityId),
    );
    const missing = unique.filter((id) => !known.has(id));
    if (!missing.length) return;
    const spec = ENTITY_SPECS[typeId];
    const res = await client.batch(
      Object.fromEntries(chunks(missing).map((part, i) => [`e${i}`, { method: spec.method, params: { filter: { '@ID': part }, select: [...spec.select] } }])),
    );
    await this.saveEntities(portal, typeId, Object.values(res.result).flatMap((r) => (Array.isArray(r) ? (r as CrmRow[]) : [])));
  }

  // ---------- Изменения с последнего прохода ----------

  /**
   * Изменения после `since` (с запасом) — сделки, звонки, лиды/контакты/компании. Новые сделки и
   * звонки догружают своих клиентов. Возвращает, что удалось (сбой одного вида не мешает другим).
   */
  async sweep(portal: Portal, client: Bitrix24RestClient, kinds: readonly ('deal' | 'call' | 'entity')[], now = new Date()): Promise<void> {
    for (const kind of kinds) {
      const st = await this.state(portal.id, kind);
      // Пока идёт первичная загрузка сделок/звонков, её `since` — момент старта; изменения забираем и тогда.
      const since = new Date((st.since ?? now).getTime() - OVERLAP_MS).toISOString();
      try {
        if (kind === 'deal') {
          if (!st.fieldsKey) continue;
          const rows = await client.listAll<CrmRow>('crm.deal.list', { order: { DATE_MODIFY: 'ASC' }, filter: { '>=DATE_MODIFY': since }, select: st.fieldsKey.split(',') }, { max: 2000 });
          await this.fillEntities(portal, client, 3, await this.saveDeals(portal.id, rows));
        } else if (kind === 'call') {
          const rows = await client.listAll<CrmRow>('crm.activity.list', { order: { LAST_UPDATED: 'ASC' }, filter: { ...CALL_FILTER, '>=LAST_UPDATED': since }, select: [...CALL_FIELDS] }, { max: 2000 });
          await this.afterCalls(portal, client, await this.saveCalls(portal.id, rows));
        } else {
          for (const t of ENTITY_TYPES) {
            if (t === 3) continue; // Контакты синхронизирует отдельная устойчивая очередь.
            const spec = ENTITY_SPECS[t];
            const rows = await client.listAll<CrmRow>(spec.method, { order: { DATE_MODIFY: 'ASC' }, filter: { '>=DATE_MODIFY': since }, select: [...spec.select] }, { max: 2000 });
            await this.saveEntities(portal, t, rows);
          }
        }
        await this.setState(portal.id, kind, { since: now });
      } catch (err) {
        this.logger.warn(`portal ${portal.id}: ${kind} sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Удалено в Битрикс24 (событие) — строка остаётся, но в выборки не попадает. */
  async markDeleted(portalId: string, target: { kind: 'deal' | 'call' | 'entity'; typeId: number; id: number }): Promise<void> {
    const deletedAt = new Date();
    if (target.kind === 'deal') await this.prisma.crmDeal.updateMany({ where: { portalId, dealId: target.id }, data: { deletedAt } });
    else if (target.kind === 'call') await this.prisma.crmCall.updateMany({ where: { portalId, activityId: target.id }, data: { deletedAt } });
    else await this.prisma.crmEntity.updateMany({ where: { portalId, entityTypeId: target.typeId, entityId: target.id }, data: { deletedAt } });
  }

  // ---------- Сотрудники ----------

  /** Все сотрудники портала (работающие и уволенные — их имена есть в старых звонках). */
  async syncEmployees(portal: Portal, client: Bitrix24RestClient): Promise<void> {
    type U = { ID: string; NAME?: string; LAST_NAME?: string; PERSONAL_PHOTO?: string | null };
    const now = new Date();
    for (const active of [true, false]) {
      const rows = await client.listAll<U>('user.get', { FILTER: { USER_TYPE: 'employee', ACTIVE: active } }, { max: 20_000 });
      for (const part of chunks(rows))
        await this.prisma.$transaction(
          part
            .filter((r) => num(r.ID))
            .map((r) => {
              const data = { name: ([r.NAME, r.LAST_NAME].filter(Boolean).join(' ') || `#${r.ID}`).slice(0, 255), photo: photoUrl(r.PERSONAL_PHOTO, portal.domain), active, syncedAt: now };
              return this.prisma.portalEmployee.upsert({ where: { portalId_userId: { portalId: portal.id, userId: Number(r.ID) } }, create: { portalId: portal.id, userId: Number(r.ID), ...data }, update: data });
            }),
        );
    }
    await this.state(portal.id, 'employee');
    await this.setState(portal.id, 'employee', { since: now, backfillDoneAt: now });
  }
}

/** Стабильное сравнение JSON без зависимости от порядка ключей ответа CRM. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
