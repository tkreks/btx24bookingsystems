import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CONTACT_FIELD_CANDIDATES, MERGE_MAX_CONTACTS, SYSTEM_FIELDS, type ContactCompareDto, type ContactDuplicatesDto, type ContactFieldMapDto } from '@btx24/shared';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { contactFieldMap } from '../bitrix24/contact-field-map.js';
import { buildGroups, indexContact, page, type DuplicatesBy, type IndexedContact, type MessengerFieldCodes } from './contact-duplicates.index.js';
import { compareFields, neededStatusTypes, type CompareField, type FieldMeta, type ValueLabels } from './contact-compare.js';

/** Индекс дублей живёт 5 минут; после объединения сбрасывается. */
export const INDEX_TTL_MS = 5 * 60_000;

interface PortalIndex {
  contacts: IndexedContact[];
  builtAt: Date;
  groups: Map<DuplicatesBy, ReturnType<typeof buildGroups>>;
}

/** Свежие данные контактов из Битрикс24 (токеном сотрудника) — для сравнения и объединения. */
export interface FreshContacts {
  ids: number[];
  rows: Record<number, Record<string, unknown>>;
  meta: Record<string, FieldMeta>;
  fields: CompareField[];
  dealsCount: Record<number, number>;
}

type RawRow = { entityId: number | bigint; n: unknown; ln: unknown; sn: unknown; ph: unknown; em: unknown; im: unknown; dc: unknown; dm: unknown; a: unknown; photo: string | null; mf: unknown };
type AvatarRow = { contactId: unknown; clientAvatar: string | null };

const MESSENGER_ROLES = ['telegram', 'whatsapp', 'max', 'whatsappLid', 'telegramLogin', 'maxLogin'] as const;
const UF_CODE = /^UF_CRM_[A-Z0-9_]{1,60}$/;

/**
 * Поля ID мессенджеров по ролям — как их использует приложение: сопоставление портала (настройки «Поля»),
 * поле по умолчанию (BTX24_*) и известные кандидаты (поля Wazzup, CONTACT_FIELD_CANDIDATES). Код,
 * назначенный одной роли, другой роли не достаётся.
 */
export function messengerFieldCodes(map: ContactFieldMapDto): MessengerFieldCodes {
  const owner = new Map<string, string>();
  for (const role of MESSENGER_ROLES) if (map[role] && UF_CODE.test(map[role]!)) owner.set(map[role]!, role);
  const out: MessengerFieldCodes = {};
  for (const role of MESSENGER_ROLES) {
    const def = SYSTEM_FIELDS.find((f) => f.entity === 'contact' && f.key === role);
    const codes = [map[role], def?.defaultCode, ...(CONTACT_FIELD_CANDIDATES[role] ?? [])].filter((c): c is string => !!c && UF_CODE.test(c));
    out[role] = [...new Set(codes)].filter((c) => (owner.get(c) ?? (owner.set(c, role), role)) === role);
  }
  return out;
}

/** Значение JSON_EXTRACT: драйвер отдаёт либо JSON-текст, либо уже разобранное значение. */
const json = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

/** JSON_ARRAY значений UF-полей → { код: значение } (элемент может прийти JSON-текстом). */
function ufValues(codes: string[], mf: unknown): Record<string, unknown> {
  const list = json(mf);
  if (!Array.isArray(list)) return {};
  return Object.fromEntries(codes.map((c, i) => [c, json(list[i])]));
}

/**
 * Блок дашборда «Дубли контактов» (ADR 0022): поиск — по копии CRM (`CrmEntity`, тип 3), сравнение —
 * по свежим данным Битрикс24 токеном сотрудника. Доступ — только постоянные администраторы (guard контроллера).
 */
@Injectable()
export class ContactDuplicatesService {
  private readonly cache = new Map<string, PortalIndex>();
  private readonly building = new Map<string, Promise<PortalIndex>>();

  constructor(private readonly prisma: PrismaService) {}

  async list(user: B24UserContext, q: { by: DuplicatesBy; q?: string; cursor?: string | null; limit?: number }): Promise<ContactDuplicatesDto> {
    const index = await this.index(user.portal.id);
    let groups = index.groups.get(q.by);
    if (!groups) index.groups.set(q.by, (groups = buildGroups(index.contacts, q.by)));
    return page(groups, q, { scanned: index.contacts.length, builtAt: index.builtAt.toISOString() });
  }

  /** После объединения (или иного изменения контактов) — построить индекс заново при следующем запросе. */
  invalidate(portalId: string): void {
    this.cache.delete(portalId);
  }

  private async index(portalId: string): Promise<PortalIndex> {
    const hit = this.cache.get(portalId);
    if (hit && Date.now() - hit.builtAt.getTime() < INDEX_TTL_MS) return hit;
    const pending = this.building.get(portalId);
    if (pending) return pending;
    const p = this.build(portalId).finally(() => this.building.delete(portalId));
    this.building.set(portalId, p);
    return p;
  }

  private async build(portalId: string): Promise<PortalIndex> {
    // Только нужные поля row (~27 тыс. контактов): весь row с UF_* — лишние мегабайты. IM — массив
    // {VALUE_TYPE, VALUE} (на портале 2026-10-30 ~8,7 тыс. значений), для значков мессенджеров.
    // mf — значения полей ID мессенджеров в порядке `codes` (пути — параметрами, коды проверены UF_CODE).
    const fields = messengerFieldCodes(await contactFieldMap(this.prisma, portalId));
    const codes = MESSENGER_ROLES.flatMap((role) => fields[role] ?? []);
    const mf = codes.length ? Prisma.sql`JSON_ARRAY(${Prisma.join(codes.map((c) => Prisma.sql`JSON_EXTRACT(\`row\`, ${`$.${c}`})`))})` : Prisma.sql`NULL`;
    const rows = await this.prisma.$queryRaw<RawRow[]>`
      SELECT entityId, photo, JSON_EXTRACT(\`row\`, '$.IM') AS im, ${mf} AS mf,
        JSON_EXTRACT(\`row\`, '$.NAME') AS n, JSON_EXTRACT(\`row\`, '$.LAST_NAME') AS ln, JSON_EXTRACT(\`row\`, '$.SECOND_NAME') AS sn,
        JSON_EXTRACT(\`row\`, '$.PHONE') AS ph, JSON_EXTRACT(\`row\`, '$.EMAIL') AS em,
        JSON_EXTRACT(\`row\`, '$.DATE_CREATE') AS dc, JSON_EXTRACT(\`row\`, '$.DATE_MODIFY') AS dm, JSON_EXTRACT(\`row\`, '$.ASSIGNED_BY_ID') AS a
      FROM CrmEntity WHERE portalId = ${portalId} AND entityTypeId = 3 AND deletedAt IS NULL`;
    // Фото контакта в копии CRM бывает редко; иначе — аватарка клиента из его последнего чата открытой
    // линии (URL CDN Битрикс24, открывается без токена; так же — в звонках, call-client-links).
    const avatars = await this.prisma.$queryRaw<AvatarRow[]>`
      SELECT JSON_EXTRACT(crm, '$.contactId') AS contactId, clientAvatar
      FROM OpenlineChat WHERE portalId = ${portalId} AND clientAvatar IS NOT NULL
      ORDER BY lastMessageAt DESC`;
    const chatAvatar = new Map<number, string>();
    for (const a of avatars) {
      const id = Number(json(a.contactId));
      if (id > 0 && a.clientAvatar && !chatAvatar.has(id)) chatAvatar.set(id, a.clientAvatar);
    }
    const contacts = rows.map((r) =>
      indexContact(Number(r.entityId), {
        NAME: json(r.n),
        LAST_NAME: json(r.ln),
        SECOND_NAME: json(r.sn),
        PHONE: json(r.ph),
        EMAIL: json(r.em),
        IM: json(r.im),
        ...ufValues(codes, r.mf),
        DATE_CREATE: json(r.dc),
        DATE_MODIFY: json(r.dm),
        ASSIGNED_BY_ID: json(r.a),
      }, r.photo || chatAvatar.get(Number(r.entityId)) || null, fields),
    );
    const index: PortalIndex = { contacts, builtAt: new Date(), groups: new Map() };
    this.cache.set(portalId, index);
    return index;
  }

  async compare(user: B24UserContext, ids: number[]): Promise<ContactCompareDto> {
    const fresh = await this.fresh(user, ids);
    const contacts = fresh.ids.map((id) => {
      const c = indexContact(id, fresh.rows[id]!);
      return { id, name: c.name, phones: c.phones, emails: c.emails, createdAt: c.createdAt, modifiedAt: c.modifiedAt, assignedById: c.assignedById, messengers: c.messengers, dealsCount: fresh.dealsCount[id] ?? 0 };
    });
    return { contacts, fields: fresh.fields.map(({ raw: _raw, ...f }) => f), suggestedPrimaryId: suggestPrimary(contacts) };
  }

  /**
   * Контакты, описание полей, подписи значений и число сделок — одним-двумя пакетами, токеном сотрудника
   * (его права в CRM). Контакт не вернулся (удалён/нет прав) → 404.
   */
  async fresh(user: B24UserContext, ids: number[]): Promise<FreshContacts> {
    assertIds(ids);
    const cmd: Record<string, { method: string; params?: Record<string, unknown> }> = { fields: { method: 'crm.contact.fields' } };
    for (const id of ids) {
      cmd[`c${id}`] = { method: 'crm.contact.get', params: { id } };
      // CONTACT_ID в фильтре crm.deal.list — сделки, где контакт привязан (как в остальных модулях).
      cmd[`d${id}`] = { method: 'crm.deal.list', params: { filter: { CONTACT_ID: id }, select: ['ID'] } };
    }
    const res = await user.client.batch(cmd);
    const rows: Record<number, Record<string, unknown>> = {};
    const dealsCount: Record<number, number> = {};
    for (const id of ids) {
      const row = res.result[`c${id}`];
      if (!row || typeof row !== 'object' || res.errors[`c${id}`]) throw new NotFoundException({ code: 'CONTACT_NOT_FOUND', message: `Контакт #${id} не найден в Битрикс24 или недоступен` });
      rows[id] = row as Record<string, unknown>;
      const deals = res.result[`d${id}`];
      dealsCount[id] = res.total[`d${id}`] ?? (Array.isArray(deals) ? deals.length : 0);
    }
    const meta = (res.result.fields ?? {}) as Record<string, FieldMeta>;
    const labels = await this.labels(user, ids, rows, meta);
    return { ids, rows, meta, fields: compareFields(ids, rows, meta, labels), dealsCount };
  }

  private async labels(user: B24UserContext, ids: number[], rows: Record<number, Record<string, unknown>>, meta: Record<string, FieldMeta>): Promise<ValueLabels> {
    const labels: ValueLabels = { statuses: {}, users: {}, companies: {} };
    const types = neededStatusTypes(meta, ids, rows);
    if (types.length) {
      const res = await user.client.batch(Object.fromEntries(types.map((t, i) => [`s${i}`, { method: 'crm.status.list', params: { filter: { ENTITY_ID: t } } }])));
      types.forEach((t, i) => {
        const list = res.result[`s${i}`];
        labels.statuses[t] = Object.fromEntries((Array.isArray(list) ? list : []).map((s: { STATUS_ID?: string; NAME?: string }) => [String(s.STATUS_ID), String(s.NAME ?? s.STATUS_ID)]));
      });
    }
    const userIds = new Set<number>();
    const companyIds = new Set<number>();
    for (const [code, m] of Object.entries(meta))
      for (const id of ids) {
        const v = Number(rows[id]?.[code]);
        if (!(v > 0)) continue;
        if (m.type === 'user' || m.type === 'employee') userIds.add(v);
        if (m.type === 'crm_company') companyIds.add(v);
      }
    if (userIds.size)
      for (const e of await this.prisma.portalEmployee.findMany({ where: { portalId: user.portal.id, userId: { in: [...userIds] } }, select: { userId: true, name: true } }))
        labels.users[e.userId] = e.name;
    if (companyIds.size)
      for (const e of await this.prisma.crmEntity.findMany({ where: { portalId: user.portal.id, entityTypeId: 4, entityId: { in: [...companyIds] }, deletedAt: null }, select: { entityId: true, title: true } }))
        labels.companies[e.entityId] = e.title;
    return labels;
  }
}

export function assertIds(ids: number[]): void {
  if (ids.length < 2 || ids.length > MERGE_MAX_CONTACTS || new Set(ids).size !== ids.length || !ids.every((id) => Number.isSafeInteger(id) && id > 0))
    throw new BadRequestException({ code: 'INVALID_CONTACT_IDS', message: `Выберите от 2 до ${MERGE_MAX_CONTACTS} разных контактов` });
}

/** Больше сделок; при равенстве — старше (DATE_CREATE), затем меньший ID. */
export function suggestPrimary(contacts: { id: number; createdAt: string | null; dealsCount: number }[]): number {
  const t = (s: string | null) => (s ? Date.parse(s) : Number.POSITIVE_INFINITY);
  return [...contacts].sort((a, b) => b.dealsCount - a.dealsCount || t(a.createdAt) - t(b.createdAt) || a.id - b.id)[0]!.id;
}
