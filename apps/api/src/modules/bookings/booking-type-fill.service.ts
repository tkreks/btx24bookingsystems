import { Injectable, Logger, Optional } from '@nestjs/common';
import { detectBookingType, type GroupOptionsDto } from '@btx24/shared';
import type { Portal } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Bitrix24RestClient } from '../bitrix24/rest/rest-client.js';
import { ActionLogService } from '../audit/action-log.service.js';
import { DealFieldMapService } from './deal-field-map.service.js';

const BATCH = 50;
const MAX_DEALS = 500;

/**
 * Тип брони по товарам — как БП 270, но без БП (решение владельца 2026-10-22): менеджер не выбрал
 * тип, а товары в сделку добавил — приложение само заполняет поле «Тип бронирования». Берёт
 * изменённые с прошлого прохода сделки в работе из воронок групп с типами брони; заполненное
 * поле не трогает (выбор менеджера важнее).
 */
@Injectable()
export class BookingTypeFillService {
  private readonly logger = new Logger(BookingTypeFillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fieldMap: DealFieldMapService,
    @Optional() private readonly actions?: ActionLogService,
  ) {}

  /** Один проход: `since` — сделки, изменённые с этого момента. Возвращает число заполненных. */
  async fill(portal: Portal, client: Bitrix24RestClient, since: Date): Promise<number> {
    const field = (await this.fieldMap.get(portal.id)).bookingType;
    if (!field) return 0;
    const groups = await this.prisma.workGroup.findMany({ where: { portalId: portal.id, archivedAt: null, dealCategoryId: { not: null } } });
    const rulesByCategory = new Map<number, NonNullable<GroupOptionsDto['bookingTypes']>>();
    for (const g of groups) {
      const rules = (g.options as GroupOptionsDto | null)?.bookingTypes ?? [];
      if (rules.length && !rulesByCategory.has(g.dealCategoryId!)) rulesByCategory.set(g.dealCategoryId!, rules);
    }
    if (!rulesByCategory.size) return 0;

    type Deal = { ID: string; CATEGORY_ID: string } & Record<string, unknown>;
    const deals = await client.listAll<Deal>(
      'crm.deal.list',
      {
        filter: { '@CATEGORY_ID': [...rulesByCategory.keys()], STAGE_SEMANTIC_ID: 'P', '>=DATE_MODIFY': since.toISOString() },
        select: ['ID', 'CATEGORY_ID', field],
        order: { DATE_MODIFY: 'DESC' },
      },
      { max: MAX_DEALS },
    );
    const empty = deals.filter((d) => d[field] === null || d[field] === undefined || d[field] === '' || d[field] === false);
    let filled = 0;
    for (let i = 0; i < empty.length; i += BATCH) {
      const part = empty.slice(i, i + BATCH);
      const rows = await client.batch(Object.fromEntries(part.map((d) => [`p${d.ID}`, { method: 'crm.deal.productrows.get', params: { id: d.ID } }])));
      for (const d of part) {
        const names = ((rows.result[`p${d.ID}`] as { PRODUCT_NAME?: string }[] | undefined) ?? []).map((r) => r.PRODUCT_NAME ?? '').filter(Boolean);
        if (!names.length) continue;
        const type = detectBookingType(rulesByCategory.get(Number(d.CATEGORY_ID)) ?? [], names);
        if (!type?.rule.dealTypeValue) continue;
        const value = await this.fieldMap.enumId(portal.id, client, field, type.rule.dealTypeValue);
        if (!value) {
          this.logger.warn(`deal ${d.ID}: value «${type.rule.dealTypeValue}» of «${type.rule.title}» is not a variant of ${field} — skipped`);
          continue;
        }
        try {
          await client.call('crm.deal.update', { id: Number(d.ID), fields: { [field]: value } });
          filled++;
          this.logger.log(`deal ${d.ID}: booking type «${type.rule.title}» filled by products`);
          await this.actions?.log(portal.id, { kind: 'system', name: 'Система: тип брони по товарам' }, {
            action: 'deal.update',
            summary: `Сделка #${d.ID}: тип брони «${type.rule.title}» определён по товарам и записан`,
            entityType: 'deal',
            entityId: Number(d.ID),
            details: { changes: [{ field, label: 'Тип бронирования', before: null, after: type.rule.title }], products: names },
            via: 'worker',
          });
        } catch (e) {
          this.logger.warn(`deal ${d.ID}: booking type not filled: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    return filled;
  }
}
