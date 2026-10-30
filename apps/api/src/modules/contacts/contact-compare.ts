import type { ContactCompareFieldDto } from '@btx24/shared';

/**
 * Окно сравнения дублей (ADR 0022): какие поля показывать, как их подписать и где конфликт.
 * Чистые функции — их же использует объединение, чтобы заново посчитать конфликты по свежим данным.
 */

/** Описание поля из `crm.contact.fields`. */
export interface FieldMeta {
  type?: string;
  isReadOnly?: boolean;
  isMultiple?: boolean;
  title?: string;
  listLabel?: string;
  formLabel?: string;
  statusType?: string;
  items?: { ID?: string | number; VALUE?: string }[];
}

/** Телефоны, почта, мессенджеры, сайты: Битрикс24 при объединении складывает их сам. */
export const MULTI_FIELDS = new Set(['PHONE', 'EMAIL', 'IM', 'WEB', 'LINK']);

/** Служебные поля — не показываются и не выравниваются. */
const SERVICE_FIELDS = new Set([
  'ID',
  'DATE_CREATE',
  'DATE_MODIFY',
  'CREATED_BY_ID',
  'MODIFY_BY_ID',
  'LAST_ACTIVITY_TIME',
  'LAST_ACTIVITY_BY',
  'LAST_COMMUNICATION_TIME',
  'ORIGINATOR_ID',
  'ORIGIN_ID',
  'ORIGIN_VERSION',
  'FACE_ID',
  'LEAD_ID',
  'COMPANY_IDS',
  'PHOTO',
]);

/** Подписи значений: статусы CRM (по statusType), сотрудники, компании. */
export interface ValueLabels {
  statuses: Record<string, Record<string, string>>;
  users: Record<number, string>;
  companies: Record<number, string>;
}

export interface CompareField extends ContactCompareFieldDto {
  /** Сырые значения из Битрикс24 по ID контакта — для записи выбранного. */
  raw: Record<number, unknown>;
}

const ID_TYPES = new Set(['user', 'crm_company', 'crm_lead', 'crm_contact', 'crm_deal', 'employee']);

export function shownField(code: string, meta: FieldMeta): boolean {
  if (MULTI_FIELDS.has(code)) return true;
  if (SERVICE_FIELDS.has(code) || code.startsWith('HAS_') || code.startsWith('ORIGIN')) return false;
  if (meta.isReadOnly || meta.type === 'file' || meta.type === 'crm_multifield') return false;
  return true;
}

export function isEmpty(v: unknown, meta?: FieldMeta): boolean {
  if (v === null || v === undefined || v === false) return true;
  if (typeof v === 'string') return v.trim() === '' || (ID_TYPES.has(meta?.type ?? '') && v.trim() === '0');
  if (typeof v === 'number') return ID_TYPES.has(meta?.type ?? '') && v === 0;
  if (Array.isArray(v)) return v.every((x) => isEmpty(x, meta));
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

/** Значение для сравнения: пусто → null, строки — без лишних пробелов. */
export function normalized(v: unknown, meta?: FieldMeta): string | null {
  if (isEmpty(v, meta)) return null;
  const one = (x: unknown) => (typeof x === 'string' ? x.trim().replace(/\s+/g, ' ') : typeof x === 'object' ? JSON.stringify(x) : String(x));
  return Array.isArray(v) ? JSON.stringify(v.filter((x) => !isEmpty(x, meta)).map(one)) : one(v);
}

const multiValues = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [])
    .map((x) => (x && typeof x === 'object' ? String((x as { VALUE?: unknown }).VALUE ?? '') : String(x ?? '')).trim())
    .filter(Boolean);

function display(v: unknown, meta: FieldMeta, labels: ValueLabels): string | null {
  if (isEmpty(v, meta)) return null;
  if (Array.isArray(v))
    return (
      v
        .filter((x) => !isEmpty(x, meta))
        .map((x) => display(x, meta, labels))
        .filter(Boolean)
        .join(', ') || null
    );
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v).trim();
  switch (meta.type) {
    case 'char':
      return s === 'Y' ? 'Да' : s === 'N' ? 'Нет' : s;
    case 'boolean':
      return ['1', 'Y', 'true'].includes(s) ? 'Да' : 'Нет';
    case 'crm_status':
      return (meta.statusType && labels.statuses[meta.statusType]?.[s]) || s;
    case 'enumeration':
      return meta.items?.find((i) => String(i.ID) === s)?.VALUE ?? s;
    case 'user':
    case 'employee':
      return labels.users[Number(s)] ?? `#${s}`;
    case 'crm_company':
      return labels.companies[Number(s)] ?? `Компания #${s}`;
    default:
      return s;
  }
}

export const fieldLabel = (code: string, meta: FieldMeta) => meta.listLabel || meta.formLabel || meta.title || code;

/** Поля окна сравнения: непустые хотя бы у одного контакта; conflict — разные заполненные значения. */
export function compareFields(ids: number[], rows: Record<number, Record<string, unknown>>, meta: Record<string, FieldMeta>, labels: ValueLabels): CompareField[] {
  const out: CompareField[] = [];
  for (const [code, m] of Object.entries(meta)) {
    if (!shownField(code, m)) continue;
    const raw: Record<number, unknown> = {};
    for (const id of ids) raw[id] = rows[id]?.[code] ?? null;
    if (ids.every((id) => isEmpty(raw[id], m))) continue;
    const values: Record<string, string | string[] | null> = {};
    if (MULTI_FIELDS.has(code)) {
      for (const id of ids) values[String(id)] = multiValues(raw[id]).length ? multiValues(raw[id]) : null;
      out.push({ code, label: fieldLabel(code, m), kind: 'multi', values, conflict: false, raw });
      continue;
    }
    for (const id of ids) values[String(id)] = display(raw[id], m, labels);
    const distinct = new Set(ids.map((id) => normalized(raw[id], m)).filter((x) => x !== null));
    out.push({ code, label: fieldLabel(code, m), kind: 'single', values, conflict: distinct.size >= 2, raw });
  }
  return out;
}

/** Статусы CRM, нужные для подписей (TYPE_ID → CONTACT_TYPE, SOURCE_ID → SOURCE, …). */
export function neededStatusTypes(meta: Record<string, FieldMeta>, ids: number[], rows: Record<number, Record<string, unknown>>): string[] {
  const out = new Set<string>();
  for (const [code, m] of Object.entries(meta))
    if (m.type === 'crm_status' && m.statusType && shownField(code, m) && ids.some((id) => !isEmpty(rows[id]?.[code], m))) out.add(m.statusType);
  return [...out];
}

/** Значение для записи «очистить поле». */
export function emptyValue(meta: FieldMeta): unknown {
  return meta.isMultiple ? [] : '';
}
