import { Injectable, Logger } from '@nestjs/common';
import type { DealFieldMapDto, DealFieldRole } from '@btx24/shared';
import type { BookingRecord } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { Bitrix24Error } from '../bitrix24/rest/errors.js';
import type { Bitrix24RestClient } from '../bitrix24/rest/rest-client.js';
import { dealDateFields, zonedIso } from './deal-dates.js';
import { DealFieldMapService } from './deal-field-map.service.js';

/** Кем и в каком поясе пересчитываются поля: сотрудник (его токен) или фоновая задача (токен приложения). */
export interface DealFieldsContext {
  portalId: string;
  timezone: string;
  client: Bitrix24RestClient;
}
export const userFieldsContext = (user: B24UserContext): DealFieldsContext => ({ portalId: user.portal.id, timezone: user.portal.timezone, client: user.client });

/** Поля сделки, которые ведёт пересчёт: номер и даты ближайшей брони, даты визита и список броней. */
export const BOOKING_REFRESH_ROLES: readonly DealFieldRole[] = [
  'bookingId',
  'bookingStart',
  'bookingEnd',
  'visitDateStart',
  'visitTimeStart',
  'visitDateEnd',
  'visitTimeEnd',
  'bookingsList',
];

type Rec = Pick<BookingRecord, 'bookingId' | 'startsAt' | 'endsAt' | 'resourceIds'>;
type Value = string | string[];

/** `#6060 | Баня 6 | 2026-12-15T04:00:00+03:00 | 2026-12-15T08:00:00+03:00` — время в поясе портала. */
export function bookingLine(r: Rec, names: Map<number, string>, timeZone: string): string {
  const ids = (Array.isArray(r.resourceIds) ? r.resourceIds : []).map(Number);
  const resources = ids.map((id) => names.get(id) ?? `Ресурс #${id}`).join(', ');
  return `#${r.bookingId} | ${resources} | ${zonedIso(r.startsAt, timeZone)} | ${zonedIso(r.endsAt, timeZone)}`;
}

/**
 * Бронь для одиночных полей: текущая или ближайшая будущая (раньше начало — раньше), иначе — последняя
 * прошедшая. null — действующих броней нет.
 */
export function nearestBooking<T extends Rec>(records: T[], now: Date): T | null {
  const t = now.getTime();
  const ahead = records.filter((r) => r.endsAt.getTime() > t).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.bookingId - b.bookingId);
  if (ahead.length) return ahead[0];
  const past = [...records].sort((a, b) => b.endsAt.getTime() - a.endsAt.getTime() || b.startsAt.getTime() - a.startsAt.getTime() || b.bookingId - a.bookingId);
  return past[0] ?? null;
}

/**
 * Значения полей сделки по её действующим броням (только настроенные поля). Нет броней — одиночные
 * поля и список пустые (очистка).
 */
export function dealBookingFieldValues(map: DealFieldMapDto, records: Rec[], names: Map<number, string>, timeZone: string, now: Date): Record<string, Value> {
  const active = [...records].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.bookingId - b.bookingId);
  const out: Record<string, Value> = {};
  for (const role of BOOKING_REFRESH_ROLES) {
    const code = map[role];
    if (code && role !== 'bookingsList') out[code] = '';
  }
  const near = nearestBooking(active, now);
  if (near) {
    if (map.bookingId) out[map.bookingId] = String(near.bookingId);
    Object.assign(out, dealDateFields(map, near.startsAt, near.endsAt, timeZone));
  }
  if (map.bookingsList) out[map.bookingsList] = active.map((r) => bookingLine(r, names, timeZone));
  return out;
}

const ISO_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:?\d{2}|Z)$/;
const DATE_RU = /^(\d{2})\.(\d{2})\.(\d{4})$/;
const listOf = (v: unknown): string[] => (Array.isArray(v) ? v : v === null || v === undefined || v === false || v === '' ? [] : [v]).map((x) => String(x ?? '').trim()).filter(Boolean);
const scalarOf = (v: unknown): string => (Array.isArray(v) ? String(v[0] ?? '') : v === null || v === undefined || v === false ? '' : String(v)).trim();

/** Совпадает ли значение сделки с нужным: формат ответа Битрикс24 у дат/чисел другой, чем при записи. */
export function sameFieldValue(current: unknown, wanted: Value): boolean {
  if (Array.isArray(wanted)) {
    const c = listOf(current);
    return c.length === wanted.length && c.every((v, i) => v === wanted[i]);
  }
  const c = scalarOf(current);
  if (c === wanted) return true;
  if (!c || !wanted) return false;
  // «Дата и время»: тот же момент в любом поясе ответа.
  if (ISO_OFFSET.test(wanted) && ISO_OFFSET.test(c)) return Date.parse(c) === Date.parse(wanted);
  // «Дата»: ответ `2026-12-15T00:00:00+03:00` — сравниваем календарную дату.
  const d = DATE_RU.exec(wanted);
  if (d && /^\d{4}-\d{2}-\d{2}/.test(c)) return c.slice(0, 10) === `${d[3]}-${d[2]}-${d[1]}`;
  return false;
}

/**
 * Номер, даты ближайшей брони, даты визита и список «Брони сделки» по журналу броней приложения
 * (`BookingRecord`, только действующие). Пишет одним `crm.deal.update` только изменившиеся поля —
 * тем клиентом, что передан: режим «только чтение» и песочница действуют как при создании брони.
 * Никогда не бросает: всё, что не удалось, — в предупреждения (бронь уже создана/снята).
 */
@Injectable()
export class DealBookingFieldsService {
  private readonly logger = new Logger(DealBookingFieldsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fieldMap: DealFieldMapService,
  ) {}

  async refresh(ctx: DealFieldsContext, dealId: number, now = new Date()): Promise<string[]> {
    try {
      return await this.run(ctx, dealId, now);
    } catch (err) {
      this.logger.warn(`portal ${ctx.portalId} deal ${dealId}: booking fields refresh failed: ${msg(err)}`);
      return [`Поля броней в сделке #${dealId} не обновлены: ${msg(err)}`];
    }
  }

  private async run(ctx: DealFieldsContext, dealId: number, now: Date): Promise<string[]> {
    const map = await this.map(ctx);
    if (!BOOKING_REFRESH_ROLES.some((r) => map[r])) return [];
    const records = await this.prisma.bookingRecord.findMany({
      where: { portalId: ctx.portalId, dealId, status: 'active' },
      orderBy: [{ startsAt: 'asc' }, { bookingId: 'asc' }],
    });
    const ids = [...new Set(records.flatMap((r) => (Array.isArray(r.resourceIds) ? r.resourceIds : []).map(Number)))];
    const names = new Map<number, string>();
    if (map.bookingsList && ids.length)
      for (const r of await this.prisma.resource.findMany({ where: { portalId: ctx.portalId, resourceId: { in: ids } }, select: { resourceId: true, name: true } }))
        names.set(r.resourceId, r.name);
    const wanted = dealBookingFieldValues(map, records, names, ctx.timezone, now);

    let deal: Record<string, unknown> | undefined;
    try {
      deal = (await ctx.client.call<Record<string, unknown>>('crm.deal.get', { id: dealId })).result ?? undefined;
    } catch (err) {
      return [`Поля броней в сделке #${dealId} не обновлены: сделка не прочитана (${msg(err)})`];
    }
    if (!deal) return [`Поля броней в сделке #${dealId} не обновлены: сделка не найдена`];
    const fields: Record<string, Value> = {};
    for (const [code, value] of Object.entries(wanted)) {
      if (sameFieldValue(deal[code], value)) continue;
      // Пустой список — пустая строка: так множественное поле очищается и в JSON, и в form-encoded.
      fields[code] = Array.isArray(value) && !value.length ? '' : value;
    }
    if (!Object.keys(fields).length) return [];
    try {
      await ctx.client.call('crm.deal.update', { id: dealId, fields });
      return [];
    } catch (err) {
      if (err instanceof Bitrix24Error && err.code === 'READ_ONLY_MODE')
        return [`Поля броней в сделке #${dealId} не обновлены: изменять существующие сделки не разрешено (⚙ → «Приложение» → «Запись в Битрикс24»)`];
      return [`Поля броней в сделке #${dealId} не обновлены: ${msg(err)}`];
    }
  }

  /** Сохранённая карта; «Брони сделки» без сопоставления — по названию поля («Брони сделки»). */
  private async map(ctx: DealFieldsContext): Promise<DealFieldMapDto> {
    const map = await this.fieldMap.get(ctx.portalId);
    if (map.bookingsList) return map;
    const found = await this.fieldMap.resolved(ctx.portalId, ctx.client).catch(() => ({}) as DealFieldMapDto);
    return found.bookingsList ? { ...map, bookingsList: found.bookingsList } : map;
  }
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
