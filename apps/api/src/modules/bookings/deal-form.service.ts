import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { DealFieldConfig, DealFormDto, DealFormField, GroupOptionsDto } from '@btx24/shared';
import { z } from 'zod';
import { AccessService, type GroupAccess } from '../access/access.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { Bitrix24Error } from '../bitrix24/rest/errors.js';
import { DealFieldMapService } from './deal-field-map.service.js';
import { dealFormFields, dealUpdateFields, type DealFieldMetaFull } from './deal-form.js';

const FIELDS_TTL_MS = 10 * 60_000;
const updateSchema = z.object({ groupId: z.string().min(1).max(40), values: z.record(z.string(), z.string().max(5000)) }).strict();

/**
 * Поля сделки группы (`options.dealFields`) для формы брони и правки из карточки брони. Чтение и
 * запись — токеном сотрудника (его права в CRM); запись подчиняется режиму «только чтение».
 */
@Injectable()
export class DealFormService {
  /** portalId → `crm.deal.fields` (подписи, типы, варианты списков меняются редко). */
  private readonly meta = new Map<string, { meta: Record<string, DealFieldMetaFull>; expiresAt: number }>();

  constructor(
    private readonly access: AccessService,
    private readonly fieldMap: DealFieldMapService,
  ) {}

  /** Форма: создать бронь (`booking.create`) или править (`booking.edit`); значения сделки — с `booking.details`. */
  async form(user: B24UserContext, groupId: string, dealId: number | null): Promise<DealFormDto> {
    const a = await this.access.resolve(user);
    const g = this.access.pick(a, groupId, 'booking.create') ?? this.access.pick(a, groupId, 'booking.edit');
    if (!g) throw new ForbiddenException({ code: 'NO_BOOKING_EDIT', message: 'Нет права создавать или менять брони в этой группе' });
    if (dealId && !g.permissions.includes('booking.details'))
      throw new ForbiddenException({ code: 'NO_BOOKING_DETAILS', message: 'Нет права видеть данные сделок в этой группе' });
    const deal = dealId ? await this.deal(user, dealId) : null;
    return {
      groupId,
      dealId,
      currency: currencyOf(deal),
      fields: await this.fields(user, g, deal),
    };
  }

  /** Правка из карточки брони: только изменённые поля группы, которые можно менять. */
  async update(user: B24UserContext, dealId: number, body: unknown): Promise<DealFormDto> {
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ code: 'INVALID_DEAL_FIELDS', message: 'Ожидается { groupId, values }' });
    const a = await this.access.resolve(user);
    const g = this.access.pick(a, parsed.data.groupId, 'booking.edit');
    if (!g || !g.permissions.includes('booking.details'))
      throw new ForbiddenException({ code: 'NO_BOOKING_EDIT', message: 'Нет права менять брони в этой группе' });
    const deal = await this.deal(user, dealId);
    const fields = await this.fields(user, g, deal);
    let update: Record<string, unknown>;
    try {
      update = dealUpdateFields(fields, parsed.data.values, currencyOf(deal), user.portal.timezone, false);
    } catch (e) {
      throw new BadRequestException({ code: 'INVALID_DEAL_FIELDS', message: e instanceof Error ? e.message : String(e) });
    }
    if (Object.keys(update).length) {
      try {
        await user.client.call('crm.deal.update', { id: dealId, fields: update });
      } catch (err) {
        if (err instanceof Bitrix24Error && err.code === 'READ_ONLY_MODE')
          throw new ForbiddenException({
            code: 'DEAL_READ_ONLY',
            message: 'Изменять эту сделку приложению не разрешено (⚙ → «Приложение» → «Запись в Битрикс24»)',
          });
        throw err;
      }
    }
    return this.form(user, parsed.data.groupId, dealId);
  }

  /** Поля группы для проверки значений формы создания брони (без значений сделки). */
  async createFields(user: B24UserContext, g: GroupAccess): Promise<DealFormField[]> {
    return this.fields(user, g, null);
  }

  private async fields(user: B24UserContext, g: GroupAccess, deal: Record<string, unknown> | null): Promise<DealFormField[]> {
    const configs: DealFieldConfig[] = ((g.group.options ?? null) as GroupOptionsDto | null)?.dealFields ?? [];
    if (!configs.length) return [];
    const [meta, map] = await Promise.all([this.dealMeta(user), this.fieldMap.get(user.portal.id)]);
    return dealFormFields(configs, meta, map, deal, user.portal.timezone);
  }

  private async deal(user: B24UserContext, dealId: number): Promise<Record<string, unknown>> {
    try {
      const deal = (await user.client.call<Record<string, unknown>>('crm.deal.get', { id: dealId })).result;
      if (deal) return deal;
    } catch (err) {
      if (!(err instanceof Bitrix24Error)) throw err;
    }
    throw new NotFoundException({ code: 'DEAL_NOT_FOUND', message: `Сделка #${dealId} не найдена или нет доступа` });
  }

  private async dealMeta(user: B24UserContext): Promise<Record<string, DealFieldMetaFull>> {
    const cached = this.meta.get(user.portal.id);
    if (cached && cached.expiresAt > Date.now()) return cached.meta;
    const meta = (await user.client.call<Record<string, DealFieldMetaFull>>('crm.deal.fields')).result ?? {};
    this.meta.set(user.portal.id, { meta, expiresAt: Date.now() + FIELDS_TTL_MS });
    return meta;
  }
}

const currencyOf = (deal: Record<string, unknown> | null) => (typeof deal?.CURRENCY_ID === 'string' && deal.CURRENCY_ID) || 'RUB';
