import { photoUrl } from '../bitrix24/rest/photo-url.js';

/** Строка crm.*.list как есть: коды полей → значения. */
export type CrmRow = Record<string, unknown>;

/** Поля сделки в копии всегда; к ним добавляются поля из сопоставления (`dealSelect`). */
export const DEAL_BASE_FIELDS = [
  'ID',
  'TITLE',
  'CATEGORY_ID',
  'STAGE_ID',
  'STAGE_SEMANTIC_ID',
  'CONTACT_ID',
  'ASSIGNED_BY_ID',
  'DATE_CREATE',
  'DATE_MODIFY',
  'MODIFY_BY_ID',
  'CLOSEDATE',
  'OPPORTUNITY',
  'CURRENCY_ID',
  'SOURCE_ID',
] as const;

/** Поля звонка (дела CRM) в копии — те же, что читает дашборд. */
export const CALL_FIELDS = ['ID', 'OWNER_ID', 'OWNER_TYPE_ID', 'DIRECTION', 'START_TIME', 'END_TIME', 'RESPONSIBLE_ID', 'SETTINGS', 'COMMUNICATIONS', 'LAST_UPDATED'] as const;

/** Звонки телефонии среди дел CRM. */
export const CALL_FILTER = { TYPE_ID: 2, PROVIDER_ID: 'VOXIMPLANT_CALL' } as const;

/** Лид, контакт, компания: метод списка и поля названия. Сделка — отдельно (CrmDeal). */
export const ENTITY_SPECS = {
  1: { method: 'crm.lead.list', select: ['ID', 'TITLE', 'DATE_MODIFY'] },
  3: { method: 'crm.contact.list', select: ['*', 'UF_*', 'PHONE', 'EMAIL', 'WEB', 'IM'] },
  4: { method: 'crm.company.list', select: ['ID', 'TITLE', 'DATE_MODIFY'] },
} as const;
export type EntityTypeId = keyof typeof ENTITY_SPECS;
export const ENTITY_TYPES = [1, 3, 4] as const satisfies readonly EntityTypeId[];
/** Метод списка по типу владельца (для проверки прав): 1 лид, 2 сделка, 3 контакт, 4 компания. */
export const LIST_METHOD: Record<number, string> = { 1: 'crm.lead.list', 2: 'crm.deal.list', 3: 'crm.contact.list', 4: 'crm.company.list' };
const LABELS: Record<number, string> = { 1: 'Лид', 3: 'Контакт', 4: 'Компания' };

/** Поля сделки в копии: базовые + поля из сопоставления, по алфавиту — ключ `fieldsKey`. */
export function dealSelect(extra: Iterable<string | null | undefined>): string[] {
  const codes = [...new Set([...extra].filter((x): x is string => !!x && /^[A-Z0-9_]+$/.test(x)))].filter((x) => !(DEAL_BASE_FIELDS as readonly string[]).includes(x));
  return [...DEAL_BASE_FIELDS, ...codes.sort()];
}

export const num = (v: unknown): number | null => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
export const date = (v: unknown): Date | null => {
  const t = Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? new Date(t) : null;
};

/** Колонки CrmDeal из строки crm.deal.list. */
export function dealColumns(r: CrmRow) {
  const semantic = String(r.STAGE_SEMANTIC_ID ?? '').slice(0, 1);
  return {
    dealId: num(r.ID) ?? 0,
    categoryId: Number.isFinite(Number(r.CATEGORY_ID)) && r.CATEGORY_ID !== null && r.CATEGORY_ID !== '' ? Number(r.CATEGORY_ID) : null,
    contactId: num(r.CONTACT_ID),
    assignedById: num(r.ASSIGNED_BY_ID),
    stageSemantic: semantic || null,
    createdAt: date(r.DATE_CREATE),
    modifiedAt: date(r.DATE_MODIFY),
  };
}

/** Колонки CrmCall из строки crm.activity.list. */
export function callColumns(r: CrmRow) {
  return {
    activityId: num(r.ID) ?? 0,
    ownerTypeId: Number(r.OWNER_TYPE_ID) || 0,
    ownerId: Number(r.OWNER_ID) || 0,
    responsibleId: num(r.RESPONSIBLE_ID),
    startAt: date(r.START_TIME) ?? new Date(0),
  };
}

/** Название и фото лида/контакта/компании. */
export function entityColumns(typeId: number, r: CrmRow, domain: string) {
  const title = String((typeId === 3 ? [r.NAME, r.LAST_NAME].filter(Boolean).join(' ') : r.TITLE) || `${LABELS[typeId] ?? 'Запись'} #${r.ID}`).slice(0, 255);
  const file = r.PHOTO && typeof r.PHOTO === 'object' ? (r.PHOTO as Record<string, unknown>) : null;
  return { entityId: num(r.ID) ?? 0, title, photo: typeId === 3 ? photoUrl(file?.showUrl ?? file?.url ?? r.PHOTO, domain) : null };
}

/** Контакт звонка (из COMMUNICATIONS) и владелец — какие лиды/контакты/компании нужны копии. */
export function callEntityRefs(r: CrmRow): { typeId: number; id: number }[] {
  const out: { typeId: number; id: number }[] = [];
  const owner = Number(r.OWNER_TYPE_ID);
  if ((ENTITY_TYPES as readonly number[]).includes(owner) && num(r.OWNER_ID)) out.push({ typeId: owner, id: Number(r.OWNER_ID) });
  for (const c of Array.isArray(r.COMMUNICATIONS) ? (r.COMMUNICATIONS as CrmRow[]) : [])
    if ((ENTITY_TYPES as readonly number[]).includes(Number(c.ENTITY_TYPE_ID)) && num(c.ENTITY_ID)) out.push({ typeId: Number(c.ENTITY_TYPE_ID), id: Number(c.ENTITY_ID) });
  return out;
}

/**
 * Привязки звонка для проверки прав: владелец (если у его типа есть метод списка) и клиенты из
 * COMMUNICATIONS — дело привязано и к ним. Звонок виден, если видна хоть одна: так CRM решает доступ
 * к делу. Владелец бывает и не сделкой/лидом/контактом/компанией (например, тип 14) — тогда по клиенту.
 */
export function callBindings(r: CrmRow): { typeId: number; id: number }[] {
  const owner = Number(r.OWNER_TYPE_ID);
  return [...(LIST_METHOD[owner] && num(r.OWNER_ID) ? [{ typeId: owner, id: Number(r.OWNER_ID) }] : []), ...callEntityRefs(r).filter((x) => !(x.typeId === owner && x.id === Number(r.OWNER_ID)))];
}

/** Событие CRM → что обновить в копии: вид, ID, удаление. null — событие не про копию. */
export function crmEventTarget(event: string, data: unknown): { kind: 'deal' | 'call' | 'entity'; typeId: number; id: number; deleted: boolean } | null {
  const id = num((data as { FIELDS?: { ID?: unknown } } | null)?.FIELDS?.ID);
  const m = /^ONCRM(DEAL|LEAD|CONTACT|COMPANY|ACTIVITY)(ADD|UPDATE|DELETE)$/.exec(event.toUpperCase());
  if (!m || !id) return null;
  const deleted = m[2] === 'DELETE';
  if (m[1] === 'DEAL') return { kind: 'deal', typeId: 2, id, deleted };
  if (m[1] === 'ACTIVITY') return { kind: 'call', typeId: 0, id, deleted };
  return { kind: 'entity', typeId: { LEAD: 1, CONTACT: 3, COMPANY: 4 }[m[1] as 'LEAD' | 'CONTACT' | 'COMPANY'], id, deleted };
}
