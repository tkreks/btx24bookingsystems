import type { CalendarField, DealFieldConfig } from '@btx24/shared';

/** Описание поля из `crm.deal.fields` (то, что нужно для подписи и форматирования). */
export interface DealFieldMeta {
  type?: string;
  isMultiple?: boolean;
  title?: string;
  formLabel?: string;
  listLabel?: string;
  items?: { ID: string | number; VALUE: string }[];
}

export function fieldLabel(code: string, config: DealFieldConfig | undefined, meta: DealFieldMeta | undefined): string {
  return config?.title || meta?.formLabel || meta?.listLabel || meta?.title || code;
}

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
const MONEY = /^(-?\d+(?:\.\d+)?)\|([A-Z]{3})$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * Значение поля сделки строкой для показа: списки — по названиям вариантов, «да/нет», деньги
 * («1500|RUB» → «1 500 RUB»), даты — в часовом поясе портала. Пустые значения — null; составные (файлы, адреса)
 * показываем текстом, если отдельный формат ещё не поддержан.
 */
export function formatDealValue(raw: unknown, meta: DealFieldMeta | undefined, timezone: string): string | null {
  const values = (Array.isArray(raw) ? raw : [raw]).filter((v) => v !== null && v !== undefined && v !== '');
  const parts = values.map((v) => formatOne(v, meta, timezone)).filter((v): v is string => v !== null && v !== '');
  return parts.length ? parts.join(', ') : null;
}

function formatOne(v: unknown, meta: DealFieldMeta | undefined, timezone: string): string | null {
  if (typeof v === 'object') {
    if (!v) return null;
    const row = v as Record<string, unknown>;
    // Файлы, адреса и привязки могут приходить объектами: не теряем поле целиком.
    for (const key of ['VALUE', 'TITLE', 'NAME', 'TEXT', 'ADDRESS', 'name', 'title']) {
      const label = row[key];
      if (typeof label === 'string' && label.trim()) return formatOne(label, { type: 'string' }, timezone);
    }
    return JSON.stringify(v);
  }
  const s = String(v);
  switch (meta?.type) {
    case 'enumeration':
      return meta.items?.find((i) => String(i.ID) === s)?.VALUE ?? s;
    case 'boolean':
      return s === 'Y' || s === '1' || s === 'true' ? 'Да' : 'Нет';
    case 'money': {
      const m = MONEY.exec(s);
      return m ? `${new Intl.NumberFormat('ru-RU').format(Number(m[1]))} ${m[2]}` : s;
    }
    case 'date': {
      const m = DATE.exec(s);
      return m ? `${m[3]}.${m[2]}.${m[1]}` : s;
    }
    case 'datetime': {
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) return s;
      return new Intl.DateTimeFormat('ru-RU', {
        timeZone: timezone,
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(d);
    }
    case 'double':
    case 'integer': {
      const n = Number(s);
      return Number.isFinite(n) ? new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(n) : s;
    }
    default:
      // Комментарии бывают в HTML или BB-коде редактора Битрикс24 — показываем текстом.
      return s
        .replace(/<[^>]*>|\[\/?[a-z*]+(?:=[^\]]*)?\]/gi, ' ')
        .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (_, e: string) => ENTITIES[e])
        .replace(/\s+/g, ' ')
        .trim();
  }
}

/** Поля сделки брони по настройке группы: только заполненные и только те, что где-то показываются. */
export function bookingFields(
  deal: Record<string, unknown>,
  configs: DealFieldConfig[],
  meta: Record<string, DealFieldMeta>,
  timezone: string,
): CalendarField[] {
  const out: CalendarField[] = [];
  for (const c of configs) {
    if (!c.showView && !c.showList) continue;
    const value = formatDealValue(deal[c.name], meta[c.name], timezone);
    if (value === null) continue;
    out.push({
      code: c.name,
      label: fieldLabel(c.name, c, meta[c.name]),
      value,
      inList: c.showList,
      inView: c.showView,
    });
  }
  return out;
}
