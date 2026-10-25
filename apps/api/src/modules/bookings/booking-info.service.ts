import { Injectable, NotFoundException } from '@nestjs/common';
import type { BookingInfoDto, DealFieldConfig } from '@btx24/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { photoUrl } from '../bitrix24/rest/photo-url.js';
import { bookingFields, type DealFieldMeta } from '../calendar/deal-fields.js';
import { DealFieldMapService } from './deal-field-map.service.js';
import { paidSum } from './deal-outcome.js';

type Row = Record<string, unknown>;
/** Описание полей сделки (`crm.deal.fields`) меняется редко — на 10 минут на портал. */
const META_TTL_MS = 10 * 60_000;

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * Карточка брони с дашборда («Ближайшие / Текущие брони»): бронь из журнала, сделка, клиент, поля сделки
 * по настройке группы ресурса и товары сделки. Сделка, клиент и товары — правами сотрудника в CRM.
 */
@Injectable()
export class BookingInfoService {
  private readonly meta = new Map<string, { value: Record<string, DealFieldMeta>; expiresAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly fieldMap: DealFieldMapService,
  ) {}

  async info(user: B24UserContext, bookingId: number, dealFields: DealFieldConfig[]): Promise<BookingInfoDto> {
    const record = await this.prisma.bookingRecord.findFirst({ where: { portalId: user.portal.id, bookingId } });
    if (!record) throw new NotFoundException({ code: 'BOOKING_NOT_FOUND', message: `Бронь #${bookingId} не найдена` });
    const resourceIds = (record.resourceIds as number[]).map(Number);
    const resources = await this.prisma.resource.findMany({ where: { portalId: user.portal.id, resourceId: { in: resourceIds } }, select: { resourceId: true, name: true } });
    const names = new Map(resources.map((r) => [r.resourceId, r.name]));
    const booking: BookingInfoDto['booking'] = {
      id: record.bookingId,
      title: record.title,
      start: record.startsAt.toISOString(),
      end: record.endsAt.toISOString(),
      resources: resourceIds.map((id) => names.get(id) ?? `Ресурс ${id}`),
      status: record.status,
      source: record.source,
    };
    if (!record.dealId) return { booking, deal: null, client: null, fields: [], products: [] };

    const dealId = record.dealId;
    const deal = (await user.client.call<Row>('crm.deal.get', { id: dealId }).catch(() => null))?.result;
    // Нет доступа к сделке в CRM — только сама бронь.
    if (!deal?.ID) return { booking, deal: null, client: null, fields: [], products: [] };
    const categoryId = Number(deal.CATEGORY_ID ?? 0) || 0;
    const contactId = Number(deal.CONTACT_ID) || 0;
    const assignedId = Number(deal.ASSIGNED_BY_ID) || 0;
    const [outcome, meta, res] = await Promise.all([
      this.fieldMap.outcome(user.portal.id, user.client).catch(() => null),
      dealFields.some((f) => f.showView || f.showList) ? this.fieldMeta(user) : Promise.resolve({}),
      user.client.batch({
        products: { method: 'crm.deal.productrows.get', params: { id: dealId } },
        stages: { method: 'crm.status.list', params: { filter: { ENTITY_ID: categoryId ? `DEAL_STAGE_${categoryId}` : 'DEAL_STAGE' } } },
        ...(contactId ? { contact: { method: 'crm.contact.get', params: { id: contactId } } } : {}),
        ...(assignedId ? { assigned: { method: 'user.get', params: { ID: assignedId } } } : {}),
      }),
    ]);
    const stages = (res.result.stages as Row[] | undefined) ?? [];
    const stage = stages.find((s) => str(s.STATUS_ID) === str(deal.STAGE_ID));
    const contact = res.result.contact as Row | undefined;
    const assigned = ((res.result.assigned as Row[] | undefined) ?? [])[0];
    const photo = contact?.PHOTO && typeof contact.PHOTO === 'object' ? (contact.PHOTO as Row) : null;
    const products = ((res.result.products as Row[] | undefined) ?? []).map((p) => {
      const quantity = num(p.QUANTITY) ?? 0;
      const price = num(p.PRICE) ?? 0;
      return { name: str(p.PRODUCT_NAME) || 'Товар', quantity, price, sum: Math.round(quantity * price * 100) / 100 };
    });
    return {
      booking,
      deal: {
        id: dealId,
        title: str(deal.TITLE) || `Сделка #${dealId}`,
        stage: stage ? str(stage.NAME) : null,
        amount: num(deal.OPPORTUNITY),
        currency: str(deal.CURRENCY_ID) || null,
        paid: outcome?.paidAmount ? paidSum(deal[outcome.paidAmount]) : null,
        assigned: assigned ? [assigned.NAME, assigned.LAST_NAME].map(str).filter(Boolean).join(' ') || null : null,
      },
      client: contactId
        ? {
            id: contactId,
            name: contact ? [contact.NAME, contact.LAST_NAME].map(str).filter(Boolean).join(' ') || `Контакт #${contactId}` : `Контакт #${contactId}`,
            photo: photoUrl(photo?.showUrl ?? photo?.url ?? contact?.PHOTO, user.portal.domain),
            phones: ((contact?.PHONE as { VALUE?: string }[] | undefined) ?? []).map((p) => str(p.VALUE)).filter(Boolean),
          }
        : null,
      fields: bookingFields(deal, dealFields, meta, user.portal.timezone).map(({ code, label, value }) => ({ code, label, value })),
      products,
    };
  }

  private async fieldMeta(user: B24UserContext): Promise<Record<string, DealFieldMeta>> {
    const hit = this.meta.get(user.portal.id);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const value = (await user.client.call<Record<string, DealFieldMeta>>('crm.deal.fields')).result ?? {};
    this.meta.set(user.portal.id, { value, expiresAt: Date.now() + META_TTL_MS });
    return value;
  }
}
