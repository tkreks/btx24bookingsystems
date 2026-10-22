import { Injectable, Logger, Optional } from '@nestjs/common';
import type { Bitrix24RestClient } from '../bitrix24/rest/rest-client.js';
import { ActionLogService } from '../audit/action-log.service.js';
import { DealFieldMapService, detectFieldMap } from '../bookings/deal-field-map.service.js';

type Invoice = { id: number; opportunity?: number | string | null; stageId?: string | null; currencyId?: string | null };
type Payment = { paid?: string; sum?: number | string };

/** Стадия счёта «оплачен» (`DT31_<воронка>:P`) — как `invoicePaid` в payment-flow (без цикла импортов). */
const paidStage = (stageId: unknown) => String(stageId ?? '').endsWith(':P');

/**
 * «Сумма внесённых оплат» сделки (решение владельца 2026-10-22): не прибавляется при каждой оплате,
 * а **каждый раз пересчитывается заново** по всем счетам сделки (`parentId2` = сделка): сумма
 * проведённых оплат счёта; счёт отмечен «оплачен» вручную без оплат — его сумма. Пишется в поле,
 * только если значение изменилось.
 */
@Injectable()
export class PaidAmountService {
  private readonly logger = new Logger(PaidAmountService.name);
  /** portalId → код поля «Сумма внесённых оплат», найденный по названию (если не задан в ⚙). */
  private readonly detected = new Map<string, { code: string | null; expiresAt: number }>();

  constructor(
    private readonly fieldMap: DealFieldMapService,
    @Optional() private readonly actions?: ActionLogService,
  ) {}

  /** Сумма внесённых оплат по счетам сделки. */
  async paidSum(client: Bitrix24RestClient, dealId: number): Promise<number> {
    const invoices = await client.listAll<Invoice>('crm.item.list', { entityTypeId: 31, filter: { parentId2: dealId }, select: ['id', 'opportunity', 'stageId', 'currencyId'] });
    let total = 0;
    for (const inv of invoices) {
      const res = await client.call<Payment[]>('crm.item.payment.list', { entityTypeId: 31, entityId: inv.id });
      const paid = (Array.isArray(res.result) ? res.result : []).filter((p) => p.paid === 'Y').reduce((s, p) => s + Number(p.sum ?? 0), 0);
      total += paid > 0 ? paid : paidStage(inv.stageId) ? Number(inv.opportunity ?? 0) : 0;
    }
    return Math.round(total * 100) / 100;
  }

  /** Пересчитать и записать в сделку (если изменилось). Возвращает сумму или null — поля нет. */
  async recompute(portalId: string, client: Bitrix24RestClient, dealId: number, via = 'worker'): Promise<number | null> {
    const code = await this.code(portalId, client);
    if (!code) return null;
    const [sum, deal] = await Promise.all([this.paidSum(client, dealId), client.call<Record<string, unknown>>('crm.deal.get', { id: dealId })]);
    const current = Number(String(deal.result?.[code] ?? '').split('|')[0]) || 0;
    if (Math.abs(current - sum) < 0.005) return sum;
    await client.call('crm.deal.update', { id: dealId, fields: { [code]: `${sum}|RUB` } });
    this.logger.log(`deal ${dealId}: paid amount ${current} → ${sum}`);
    await this.actions?.log(portalId, { kind: 'system', name: 'Система: пересчёт оплат по счетам' }, {
      action: 'deal.update',
      summary: `Сделка #${dealId}: «Сумма внесённых оплат» пересчитана по счетам — ${sum} ₽`,
      entityType: 'deal',
      entityId: dealId,
      details: { changes: [{ field: code, label: 'Сумма внесённых оплат', before: current, after: sum }] },
      via,
    });
    return sum;
  }

  /** Код поля: из настроек (⚙ → «Приложение» → системные поля), иначе — по названию поля в портале. */
  private async code(portalId: string, client: Bitrix24RestClient): Promise<string | null> {
    const fromMap = (await this.fieldMap.get(portalId)).paidAmount;
    if (fromMap) return fromMap;
    const hit = this.detected.get(portalId);
    if (hit && hit.expiresAt > Date.now()) return hit.code;
    const fields = (await client.call<Parameters<typeof detectFieldMap>[0]>('crm.deal.fields')).result ?? {};
    const code = detectFieldMap(fields).paidAmount ?? null;
    this.detected.set(portalId, { code, expiresAt: Date.now() + 10 * 60_000 });
    return code;
  }
}
