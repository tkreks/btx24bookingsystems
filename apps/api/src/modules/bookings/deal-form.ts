import {
  zonedTimeToUtc,
  type DealFieldConfig,
  type DealFieldMapDto,
  type DealFieldRole,
  type DealFormField,
  type DealFormFieldKind,
} from '@btx24/shared';
import { fieldLabel, formatDealValue, type DealFieldMeta } from '../calendar/deal-fields.js';

/** Мета поля с признаками из `crm.deal.fields`, нужными для правки. */
export type DealFieldMetaFull = DealFieldMeta & { isReadOnly?: boolean };

/**
 * Поля, которые заполняет само приложение (ID и даты брони, тип, счета и ссылки): в форме — только
 * для чтения, иначе правка разойдётся с бронью в Битрикс24.
 */
export const APP_FILLED_ROLES: readonly DealFieldRole[] = [
  'bookingId',
  'bookingStart',
  'bookingEnd',
  'visitDateStart',
  'visitTimeStart',
  'visitDateEnd',
  'visitTimeEnd',
  'bookingType',
  'prepaymentInvoiceId',
  'prepaymentLink',
  'surchargeInvoiceId',
  'surchargeLink',
  'paidAmount',
  'bookingsList',
];

const KINDS: Record<string, DealFormFieldKind> = {
  string: 'string',
  url: 'string',
  char: 'string',
  integer: 'number',
  double: 'number',
  money: 'money',
  enumeration: 'enum',
  boolean: 'boolean',
  date: 'date',
  datetime: 'datetime',
};

/** Поля группы для формы: настройка группы + описание поля + значение сделки (если есть). */
export function dealFormFields(
  configs: DealFieldConfig[],
  meta: Record<string, DealFieldMetaFull>,
  map: DealFieldMapDto,
  deal: Record<string, unknown> | null,
  timezone: string,
): DealFormField[] {
  const roles = new Map(Object.entries(map).map(([role, code]) => [code, role as DealFieldRole]));
  return configs
    .filter((c) => c.showCreate || c.showView)
    .map((c) => {
      const m = meta[c.name];
      const kind = KINDS[m?.type ?? ''];
      const role = roles.get(c.name) ?? null;
      const raw = deal?.[c.name];
      return {
        code: c.name,
        label: fieldLabel(c.name, c, m),
        kind: kind ?? 'string',
        required: c.required,
        readOnly: !m || !kind || !!m.isMultiple || !!m.isReadOnly || (role !== null && APP_FILLED_ROLES.includes(role)),
        inlineNext: c.inlineNext,
        showCreate: c.showCreate,
        showView: c.showView,
        ...(kind === 'enum' ? { items: (m?.items ?? []).map((i) => ({ id: String(i.ID), value: i.VALUE })) } : {}),
        role,
        ...(c.defaultValue ? { defaultValue: c.defaultValue } : {}),
        ...(c.formula?.trim() && (kind === 'number' || kind === 'money') ? { formula: c.formula.trim() } : {}),
        value: kind && !m?.isMultiple ? toFormValue(raw, kind, timezone) : '',
        display: formatDealValue(raw, m, timezone) ?? '',
      };
    });
}

/** Значение сделки → строка поля ввода. */
export function toFormValue(raw: unknown, kind: DealFormFieldKind, timezone: string): string {
  if (raw === null || raw === undefined || raw === '' || typeof raw === 'object') return '';
  const s = String(raw);
  switch (kind) {
    case 'number':
      return Number.isFinite(Number(s)) ? String(Number(s)) : '';
    case 'money': {
      const n = Number(s.split('|')[0]);
      return Number.isFinite(n) && s.split('|')[0] !== '' ? String(n) : '';
    }
    case 'boolean':
      return ['Y', '1', 'true'].includes(s) ? 'Y' : 'N';
    case 'date':
      return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
    case 'datetime': {
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) return '';
      const p = Object.fromEntries(
        new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
          .formatToParts(d)
          .map((x) => [x.type, x.value]),
      );
      return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
    }
    default:
      return s;
  }
}

/** Строка поля ввода → значение для `crm.deal.update`. Ошибка — текст для сотрудника. */
export function toBitrixValue(field: DealFormField, value: string, currency: string, timezone: string): unknown {
  const v = value.trim();
  if (!v) {
    if (field.required) throw new Error(`Заполните поле «${field.label}»`);
    return '';
  }
  switch (field.kind) {
    case 'number':
    case 'money': {
      const n = Number(v.replace(/\s/g, '').replace(',', '.'));
      if (!Number.isFinite(n)) throw new Error(`«${field.label}»: нужно число`);
      return field.kind === 'money' ? `${n}|${currency}` : n;
    }
    case 'enum':
      if (!field.items?.some((i) => i.id === v)) throw new Error(`«${field.label}»: нет такого варианта`);
      return v;
    case 'boolean':
      if (v !== 'Y' && v !== 'N') throw new Error(`«${field.label}»: да или нет`);
      return v === 'Y' ? 1 : 0;
    case 'date':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`«${field.label}»: нужна дата`);
      return v;
    case 'datetime': {
      const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(v);
      if (!m) throw new Error(`«${field.label}»: нужны дата и время`);
      return zonedTimeToUtc(m[1], m[2], timezone).toISOString();
    }
    default:
      if (v.length > 5000) throw new Error(`«${field.label}»: слишком длинный текст`);
      return v;
  }
}

/**
 * Значения формы → поля для `crm.deal.update`. Только поля группы, которые можно править; лишние
 * коды — ошибка (не доверяем клиенту). `onlyCreate` — форма создания брони (флаг «С»).
 */
export function dealUpdateFields(
  fields: DealFormField[],
  values: Record<string, string>,
  currency: string,
  timezone: string,
  onlyCreate: boolean,
): Record<string, unknown> {
  const byCode = new Map(fields.map((f) => [f.code, f]));
  const out: Record<string, unknown> = {};
  for (const [code, value] of Object.entries(values)) {
    const f = byCode.get(code);
    if (!f || f.readOnly || (onlyCreate && !f.showCreate)) throw new Error(`Поле ${code} нельзя менять в этой группе`);
    if (typeof value !== 'string') throw new Error(`«${f.label}»: неверное значение`);
    out[code] = toBitrixValue(f, value, currency, timezone);
  }
  if (onlyCreate)
    for (const f of fields)
      if (f.showCreate && f.required && !f.readOnly && !(f.code in values)) throw new Error(`Заполните поле «${f.label}»`);
  return out;
}
