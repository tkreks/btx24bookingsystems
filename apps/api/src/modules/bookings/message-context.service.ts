import { Injectable } from '@nestjs/common';
import { detectBookingType, emptyMessageContext, type GroupOptionsDto, type MessageContext } from '@btx24/shared';
import type { Portal } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Bitrix24RestClient } from '../bitrix24/rest/rest-client.js';
import { DealFieldMapService } from './deal-field-map.service.js';

type FieldMeta = {
  type?: string;
  isMultiple?: boolean;
  title?: string;
  listLabel?: string;
  formLabel?: string;
  filterLabel?: string;
  items?: { ID: string | number; VALUE: string }[];
};
type Fields = Record<string, FieldMeta>;
type Row = Record<string, unknown>;

const FIELDS_TTL_MS = 10 * 60_000;
const norm = (s: string) => s.trim().toLocaleLowerCase('ru').replace(/\s+/g, ' ');
const num = (v: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(v).replace(/[\u00a0\u202f]/g, ' ');

/** Значение поля CRM так, как его увидит клиент: списки — текстом, деньги — числом, даты — по-русски. */
export function displayValue(meta: FieldMeta | undefined, raw: unknown, timeZone: string): string {
  if (raw === null || raw === undefined || raw === '' || raw === false) return '';
  if (Array.isArray(raw))
    return raw
      .map((x) => displayValue({ ...meta, isMultiple: false }, typeof x === 'object' && x !== null && 'VALUE' in x ? (x as { VALUE: unknown }).VALUE : x, timeZone))
      .filter(Boolean)
      .join(', ');
  const type = meta?.type ?? '';
  if (type === 'enumeration') return meta?.items?.find((i) => String(i.ID) === String(raw))?.VALUE ?? String(raw);
  if (type === 'money') {
    const n = Number(String(raw).split('|')[0]);
    return Number.isFinite(n) ? num(n) : String(raw);
  }
  if (type === 'double' || type === 'integer') return Number.isFinite(Number(raw)) ? num(Number(raw)) : String(raw);
  if (type === 'boolean' || type === 'char') return raw === 'Y' || raw === '1' || raw === 1 || raw === true ? 'да' : raw === 'N' || raw === '0' ? 'нет' : String(raw);
  if (type === 'date' || type === 'datetime') {
    const d = new Date(String(raw));
    if (Number.isNaN(d.getTime())) return String(raw);
    const opts: Intl.DateTimeFormatOptions = { timeZone, day: '2-digit', month: '2-digit', year: 'numeric', ...(type === 'datetime' ? { hour: '2-digit', minute: '2-digit' } : {}) };
    return new Intl.DateTimeFormat('ru-RU', opts).format(d).replace(',', '');
  }
  if (typeof raw === 'object') return '';
  return String(raw);
}

/** Заполнить карты «название → значение» и «код → значение». */
export function mapFields(row: Row, fields: Fields, timeZone: string): { byTitle: Record<string, string>; byCode: Record<string, string> } {
  const byTitle: Record<string, string> = {};
  const byCode: Record<string, string> = {};
  for (const [code, meta] of Object.entries(fields)) {
    if (!(code in row)) continue;
    const v = displayValue(meta, row[code], timeZone);
    if (!v) continue;
    byCode[code] = v;
    for (const label of [meta.formLabel, meta.listLabel, meta.title, meta.filterLabel]) if (label && !(norm(label) in byTitle)) byTitle[norm(label)] = v;
  }
  return { byTitle, byCode };
}

/**
 * Данные для шаблонов сообщений по сделке (ADR 0009): поля сделки и контакта по названиям и кодам,
 * программа и тип брони по товарам (правила групп), короткие переменные приложения. Читает токеном,
 * который передали (сотрудник — его права CRM; worker — приложение).
 */
@Injectable()
export class MessageContextService {
  private readonly cache = new Map<string, { fields: Fields; expiresAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly fieldMap: DealFieldMapService,
  ) {}

  async forDeal(portal: Portal, client: Bitrix24RestClient, dealId: number | null): Promise<MessageContext & { deal: Row | null }> {
    const ctx = { ...emptyMessageContext(), deal: null as Row | null };
    if (!dealId) return ctx;
    const deal = (await client.call<Row>('crm.deal.get', { id: dealId })).result ?? null;
    if (!deal) return ctx;
    ctx.deal = deal;
    const tz = portal.timezone;
    const dealFields = await this.fields(portal, client, 'crm.deal.fields');
    const d = mapFields(deal, dealFields, tz);
    ctx.dealByTitle = d.byTitle;
    ctx.dealByCode = d.byCode;

    const contactId = Number(deal.CONTACT_ID) || 0;
    if (contactId) {
      try {
        const contact = (await client.call<Row>('crm.contact.get', { id: contactId })).result ?? {};
        const c = mapFields(contact, await this.fields(portal, client, 'crm.contact.fields'), tz);
        ctx.contact = { ...c.byTitle, ...c.byCode };
      } catch {
        /* без контакта — {{Контакт: …}} останутся в тексте */
      }
    }

    // Программа и тип брони — по товарам сделки и правилам групп с воронкой сделки.
    try {
      const rows = (await client.call<{ PRODUCT_NAME?: string; QUANTITY?: number | string }[]>('crm.deal.productrows.get', { id: dealId })).result ?? [];
      const names = rows.map((r) => r.PRODUCT_NAME ?? '').filter(Boolean);
      // «Товары брони» для клиента: название, количество — если больше одного.
      ctx.variables.products = rows
        .filter((r) => r.PRODUCT_NAME)
        .map((r) => (Number(r.QUANTITY) > 1 ? `${r.PRODUCT_NAME} × ${num(Number(r.QUANTITY))}` : r.PRODUCT_NAME!))
        .join(', ');
      const groups = await this.prisma.workGroup.findMany({ where: { portalId: portal.id, archivedAt: null, dealCategoryId: Number(deal.CATEGORY_ID ?? 0) } });
      for (const g of groups) {
        const hit = detectBookingType((g.options as GroupOptionsDto | null)?.bookingTypes ?? [], names);
        if (hit) {
          ctx.variables.programm = hit.program;
          ctx.variables.dealtype = hit.rule.title;
          break;
        }
      }
      ctx.variables.tovary = names.join(', ');
    } catch {
      /* без товаров — программа не определена */
    }

    const map = await this.fieldMap.get(portal.id);
    const raw = (code?: string) => (code ? (d.byCode[code] ?? '') : '');
    ctx.vars = {
      client_name: ctx.contact['имя'] ?? ctx.contact.NAME ?? '',
      date_start: raw(map.visitDateStart),
      time_start: raw(map.visitTimeStart),
      date_end: raw(map.visitDateEnd),
      time_end: raw(map.visitTimeEnd),
      guests: raw(map.guests),
      amount: d.byCode.OPPORTUNITY ?? '',
      program: ctx.variables.programm ?? '',
      products: ctx.variables.products ?? '',
      deal_type: ctx.variables.dealtype ?? '',
    };
    // Дом для клиента: альтернативное имя ресурса брони сделки.
    const bookingId = Number(map.bookingId ? deal[map.bookingId] : 0) || 0;
    if (bookingId) {
      const rec = await this.prisma.bookingRecord.findUnique({ where: { portalId_bookingId: { portalId: portal.id, bookingId } } });
      const ids = (rec?.resourceIds as number[] | undefined) ?? [];
      if (ids.length) {
        const res = await this.prisma.resource.findMany({ where: { portalId: portal.id, resourceId: { in: ids } } });
        ctx.vars.house = res.map((r) => r.clientName?.trim() || r.name).join(', ');
      }
    }
    return ctx;
  }

  /** Названия полей сделки и контакта портала — для подсказки в редакторе шаблонов. */
  async titles(portal: Portal, client: Bitrix24RestClient): Promise<{ deal: string[]; contact: string[] }> {
    const pick = (f: Fields) =>
      [...new Set(Object.values(f).map((m) => (m.formLabel || m.listLabel || m.title || '').trim()).filter((t) => t && !t.startsWith('UF_')))].sort((a, b) => a.localeCompare(b, 'ru'));
    const [deal, contact] = await Promise.all([this.fields(portal, client, 'crm.deal.fields'), this.fields(portal, client, 'crm.contact.fields')]);
    return { deal: pick(deal), contact: pick(contact) };
  }

  private async fields(portal: Portal, client: Bitrix24RestClient, method: string): Promise<Fields> {
    const key = `${portal.id}:${method}`;
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.fields;
    const fields = (await client.call<Fields>(method)).result ?? {};
    this.cache.set(key, { fields, expiresAt: Date.now() + FIELDS_TTL_MS });
    return fields;
  }
}
