import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { techWindowsFor, zonedDayRange, type DealFieldMapDto, type ViewerBookingDto, type ViewerDayDto, type ViewerProductsDto, type ViewerSessionDto } from '@btx24/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PortalService } from '../bitrix24/portals/portal.service.js';
import { DealFieldMapService } from '../bookings/deal-field-map.service.js';
import type { ExternalUserContext } from './external-auth.service.js';

type Paid = { at: Date; amount: number };

/** Псевдокоды видимых полей (`ExternalUser.visibleFields`) для того, что не является полем сделки. */
export const VIEWER_PSEUDO_FIELDS = { client: 'CONTACT_ID', products: 'PRODUCTS' } as const;
const PRODUCTS_TTL_MS = 5 * 60_000;
const INVOICES_TTL_MS = 2 * 60_000;

/**
 * Экран «Бронирования» внешнего пользователя (`viewer`), ADR 0021: брони — журнал приложения, сделки
 * и клиенты — копия CRM, ресурсы — их копия. Видны только ресурсы его групп и разрешённые поля сделки.
 * Товары сделки — по запросу токеном приложения (их нет в копии), только по брони из его групп.
 */
@Injectable()
export class ViewerService {
  private readonly logger = new Logger(ViewerService.name);
  private readonly products = new Map<string, { at: number; value: ViewerProductsDto }>();
  private readonly invoices = new Map<string, { at: number; value: Map<number, Paid[]> }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly portals: PortalService,
    private readonly fieldMap: DealFieldMapService,
  ) {}

  async session(ctx: ExternalUserContext): Promise<ViewerSessionDto> {
    const groups = await this.groups(ctx);
    return { login: ctx.user.login, role: 'viewer', portal: { domain: ctx.portal.domain, timezone: ctx.portal.timezone }, groups: groups.map((g) => ({ id: g.id, name: g.name })) };
  }

  async day(ctx: ExternalUserContext, date: string, groupId: string): Promise<ViewerDayDto> {
    const { portal, user } = ctx;
    const timezone = portal.timezone;
    const groups = await this.groups(ctx);
    const scope = groupId ? groups.filter((g) => g.id === groupId) : groups;
    if (groupId && !scope.length) throw new ForbiddenException({ code: 'GROUP_DENIED', message: 'Группа недоступна' });
    const allowed = new Set(scope.flatMap((g) => g.resources.map((r) => r.resourceId)));
    const { start, end } = zonedDayRange(date, timezone);
    const settings = await this.prisma.portalSettings.findUnique({ where: { portalId: portal.id }, select: { bookingSyncAt: true } });
    const empty: ViewerDayDto = { date, timezone, groupId, resources: [], bookings: [], techWindows: [], syncedAt: settings?.bookingSyncAt?.toISOString() ?? null };
    if (!allowed.size) return empty;

    const tech = Math.max(0, ...scope.map((g) => g.techWindowMinutes));
    const [resourceRows, records] = await Promise.all([
      this.prisma.resource.findMany({ where: { portalId: portal.id, archivedAt: null, resourceId: { in: [...allowed] } }, select: { resourceId: true, name: true } }),
      this.prisma.bookingRecord.findMany({ where: { portalId: portal.id, status: 'active', startsAt: { lt: end }, endsAt: { gt: new Date(start.getTime() - tech * 60_000) } }, orderBy: { startsAt: 'asc' }, take: 2000 }),
    ]);
    const mine = records.filter((r) => (r.resourceIds as number[]).some((id) => allowed.has(Number(id))));
    // Пропавшие в Битрикс24 (уведомление не закрыто) — не показываем: слот, возможно, свободен.
    const gone = mine.length
      ? new Set(
          (await this.prisma.bookingAlert.findMany({ where: { portalId: portal.id, bookingId: { in: mine.map((r) => r.bookingId) }, kind: 'discrepancy', problem: { contains: 'missing' }, status: { not: 'resolved' } }, select: { bookingId: true } })).map((a) => a.bookingId),
        )
      : new Set<number>();
    const live = mine.filter((r) => !gone.has(r.bookingId)).map((r) => ({ r, id: r.bookingId, resourceIds: (r.resourceIds as number[]).map(Number).filter((id) => allowed.has(id)), start: r.startsAt.toISOString(), end: r.endsAt.toISOString() }));
    const seen = new Set<string>();
    const techWindows = scope
      .flatMap((g) => techWindowsFor(live, g.techWindowMinutes, g.resources.map((x) => x.resourceId)))
      .filter((t) => Date.parse(t.start) < end.getTime() && Date.parse(t.end) > start.getTime())
      .filter((t) => (seen.has(`${t.resourceId}:${t.start}`) ? false : (seen.add(`${t.resourceId}:${t.start}`), true)))
      .map((t) => ({ resourceId: t.resourceId, startsAt: t.start, endsAt: t.end }));
    const inDay = live.filter((b) => b.r.startsAt < end && b.r.endsAt > start);
    const bookings = await this.cards(ctx, inDay.map((b) => ({ ...b.r, resourceIds: b.resourceIds })));
    return {
      ...empty,
      resources: resourceRows.map((r) => ({ id: r.resourceId, name: r.name })).sort((a, b) => a.name.localeCompare(b.name, 'ru')),
      bookings,
      techWindows,
    };
  }

  async productsOf(ctx: ExternalUserContext, bookingId: number): Promise<ViewerProductsDto> {
    if (!visible(ctx, VIEWER_PSEUDO_FIELDS.products)) throw new ForbiddenException({ code: 'FIELD_DENIED', message: 'Товары скрыты настройками доступа' });
    const allowed = new Set((await this.groups(ctx)).flatMap((g) => g.resources.map((r) => r.resourceId)));
    const record = await this.prisma.bookingRecord.findUnique({ where: { portalId_bookingId: { portalId: ctx.portal.id, bookingId } } });
    if (!record || !record.dealId || !(record.resourceIds as number[]).some((id) => allowed.has(Number(id)))) throw new NotFoundException({ code: 'BOOKING_NOT_FOUND', message: 'Бронь не найдена' });
    const key = `${ctx.portal.id}:${record.dealId}`;
    const hit = this.products.get(key);
    if (hit && Date.now() - hit.at < PRODUCTS_TTL_MS) return hit.value;
    const rows = (await this.portals.clientFor(ctx.portal).call<{ PRODUCT_NAME?: string; PRICE?: number | string; QUANTITY?: number | string }[]>('crm.deal.productrows.get', { id: record.dealId })).result ?? [];
    const value: ViewerProductsDto = {
      items: rows.map((p) => {
        const price = Number(p.PRICE) || 0;
        const quantity = Number(p.QUANTITY) || 0;
        return { name: String(p.PRODUCT_NAME ?? 'Товар'), price, quantity, sum: Math.round(price * quantity * 100) / 100 };
      }),
    };
    if (this.products.size > 2000) this.products.clear();
    this.products.set(key, { at: Date.now(), value });
    return value;
  }

  /** Оплаченные счета (стадия `…:P`) каждой сделки, новые сверху — токеном приложения, кэш 2 минуты. */
  private async paidInvoices(ctx: ExternalUserContext, dealIds: number[]): Promise<Map<number, Paid[]>> {
    const out = new Map<number, Paid[]>();
    if (!dealIds.length) return out;
    const key = `${ctx.portal.id}:${[...dealIds].sort((a, b) => a - b).join(',')}`;
    const hit = this.invoices.get(key);
    if (hit && Date.now() - hit.at < INVOICES_TTL_MS) return new Map(hit.value);
    try {
      const rows = await this.portals.clientFor(ctx.portal).listAll<{ parentId2?: number | null; opportunity?: number | null; stageId?: string | null; movedTime?: string | null }>(
        'crm.item.list',
        { entityTypeId: 31, filter: { '@parentId2': dealIds }, select: ['id', 'parentId2', 'opportunity', 'stageId', 'movedTime'] },
        { max: 2000, pick: (r) => ((r as { items?: never[] } | null)?.items ?? []) },
      );
      for (const i of rows) {
        const dealId = Number(i.parentId2) || 0;
        const t = Date.parse(String(i.movedTime ?? ''));
        if (!dealId || !String(i.stageId ?? '').endsWith(':P') || !Number.isFinite(t)) continue;
        out.set(dealId, [...(out.get(dealId) ?? []), { at: new Date(t), amount: Number(i.opportunity) || 0 }]);
      }
      for (const list of out.values()) list.sort((a, b) => b.at.getTime() - a.at.getTime());
    } catch (e) {
      this.logger.warn(`paid invoices: ${e instanceof Error ? e.message : String(e)}`);
      return out;
    }
    if (this.invoices.size > 500) this.invoices.clear();
    this.invoices.set(key, { at: Date.now(), value: new Map(out) });
    return out;
  }

  private groups(ctx: ExternalUserContext) {
    const { portal, user } = ctx;
    return this.prisma.workGroup.findMany({
      where: { portalId: portal.id, archivedAt: null, ...(user.allGroups ? {} : { id: { in: user.groupIds } }) },
      orderBy: [{ sort: 'asc' }, { name: 'asc' }],
      include: { resources: { select: { resourceId: true } } },
    });
  }

  private async cards(ctx: ExternalUserContext, records: { bookingId: number; title: string | null; dealId: number | null; resourceIds: number[]; startsAt: Date; endsAt: Date }[]): Promise<ViewerBookingDto[]> {
    const portalId = ctx.portal.id;
    const dealIds = [...new Set(records.flatMap((r) => (r.dealId ? [r.dealId] : [])))];
    const [deals, map] = await Promise.all([
      dealIds.length ? this.prisma.crmDeal.findMany({ where: { portalId, dealId: { in: dealIds }, deletedAt: null }, select: { dealId: true, contactId: true, row: true } }) : [],
      dealIds.length ? this.fieldMap.resolved(portalId, this.portals.clientFor(ctx.portal)).catch((e: unknown): DealFieldMapDto => (this.logger.warn(`field map: ${String(e)}`), {})) : ({} as DealFieldMapDto),
    ]);
    const byDeal = new Map(deals.map((d) => [d.dealId, d]));
    const contactIds = [...new Set(deals.flatMap((d) => (d.contactId ? [d.contactId] : [])))];
    const [contacts, payments, paidRows] = await Promise.all([
      contactIds.length && visible(ctx, VIEWER_PSEUDO_FIELDS.client) ? this.prisma.crmEntity.findMany({ where: { portalId, entityTypeId: 3, entityId: { in: contactIds } }, select: { entityId: true, title: true } }) : [],
      dealIds.length ? this.prisma.dealPayment.findMany({ where: { portalId, dealId: { in: dealIds } }, orderBy: { at: 'desc' }, select: { dealId: true, amount: true, at: true } }) : [],
      dealIds.length ? this.prisma.dealPaidAmount.findMany({ where: { portalId, dealId: { in: dealIds } }, select: { dealId: true, amount: true } }) : [],
    ]);
    const names = new Map(contacts.map((c) => [c.entityId, c.title]));
    // Последняя оплата: оплаченный счёт сделки (точное время и сумма); у сделок без оплаченных счетов —
    // рост «Суммы внесённых оплат», замеченный приложением (`DealPayment`).
    const paidBy = await this.paidInvoices(ctx, dealIds);
    const tracked = new Map<number, Paid[]>();
    for (const p of payments) tracked.set(p.dealId, [...(tracked.get(p.dealId) ?? []), { at: p.at, amount: Number(p.amount) }]);
    for (const [dealId, list] of tracked) if (!paidBy.has(dealId)) paidBy.set(dealId, list);
    const paidKnown = new Map(paidRows.map((p) => [p.dealId, Number(p.amount)]));
    const field = (row: Record<string, unknown> | undefined, code: string | undefined) => (row && code && visible(ctx, code) ? row[code] : undefined);
    return records.map((r) => {
      const deal = r.dealId ? byDeal.get(r.dealId) : undefined;
      const row = deal?.row as Record<string, unknown> | undefined;
      const paidCode = map.paidAmount;
      const paid = paidCode && visible(ctx, paidCode) ? (toNumber(row?.[paidCode]) ?? (r.dealId ? paidKnown.get(r.dealId) : undefined) ?? null) : null;
      const history = (r.dealId && paid !== null ? paidBy.get(r.dealId) : undefined) ?? [];
      const last = history[0];
      return {
        bookingId: r.bookingId,
        title: r.title || (typeof row?.TITLE === 'string' ? row.TITLE : '') || `Бронь #${r.bookingId}`,
        startsAt: r.startsAt.toISOString(),
        endsAt: r.endsAt.toISOString(),
        resourceIds: r.resourceIds,
        dealId: r.dealId,
        clientName: (deal?.contactId && names.get(deal.contactId)) || null,
        guests: toNumber(field(row, map.guests)),
        programGuests: toNumber(field(row, map.programGuests)),
        amount: toNumber(field(row, 'OPPORTUNITY'), true),
        paid,
        currency: typeof row?.CURRENCY_ID === 'string' && row.CURRENCY_ID ? row.CURRENCY_ID : 'RUB',
        lastPaymentAt: last ? last.at.toISOString() : null,
        lastPaymentAmount: last ? last.amount : null,
        payments: history.map((x) => ({ at: x.at.toISOString(), amount: x.amount })),
        comment: toText(field(row, 'COMMENTS')),
        important: toText(field(row, map.managerComment)),
        products: !!r.dealId && visible(ctx, VIEWER_PSEUDO_FIELDS.products),
      };
    });
  }
}

function visible(ctx: ExternalUserContext, code: string): boolean {
  return !ctx.user.visibleFields || ctx.user.visibleFields.includes(code);
}

/** Число из поля CRM: «5000|RUB», «6», 6; пусто — null (не ноль). `zero` — ноль допустим (сумма сделки). */
export function toNumber(v: unknown, zero = false): number | null {
  if (Array.isArray(v)) v = v[0];
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).split('|')[0].replace(',', '.').replace(/\s+/g, ''));
  if (!Number.isFinite(n)) return null;
  return n === 0 && !zero ? null : n;
}

/** Текст для людей: без HTML/BB-разметки, пустое — null. */
export function toText(v: unknown): string | null {
  const raw = Array.isArray(v) ? v.filter((x) => x !== null && x !== '').join(', ') : v === null || v === undefined ? '' : String(v);
  const text = raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\[\/?[a-z]+(=[^\]]*)?\]/gi, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
  return text || null;
}
