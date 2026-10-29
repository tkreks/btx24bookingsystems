import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { SYSTEM_FIELDS, resolveContactFields, systemFieldCompatible, type DealFieldInfo, type SystemFieldsDto } from '@btx24/shared';
import { ActionLogService } from '../audit/action-log.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { DealFieldMapService } from '../bookings/deal-field-map.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { contactFieldMap } from '../bitrix24/contact-field-map.js';

export interface CrmFieldMeta {
  type?: string; title?: string; formLabel?: string; listLabel?: string;
  isMultiple?: boolean | string; isReadOnly?: boolean | string;
  items?: { ID: string | number; VALUE: string }[];
}
const yes = (v: unknown) => v === true || v === 'Y' || v === '1';
export function crmFieldInfos(meta: Record<string, CrmFieldMeta>): DealFieldInfo[] {
  return Object.entries(meta).map(([code, f]) => ({ code, label: f.formLabel || f.listLabel || f.title || code, type: f.type ?? 'string', multiple: yes(f.isMultiple), readOnly: yes(f.isReadOnly), ...(f.items ? { items: f.items.map(i => ({ id: String(i.ID), value: i.VALUE })) } : {}) })).sort((a, b) => a.label.localeCompare(b.label, 'ru'));
}

@Injectable()
export class FieldsService {
  constructor(private readonly prisma: PrismaService, private readonly deals: DealFieldMapService, @Optional() private readonly actions?: ActionLogService) {}

  async get(user: B24UserContext): Promise<SystemFieldsDto> {
    const [deal, contact, dealMap, contactMap, resolvedDeals, settings] = await Promise.all([
      user.client.call<Record<string, CrmFieldMeta>>('crm.deal.fields'),
      user.client.call<Record<string, CrmFieldMeta>>('crm.contact.fields'),
      this.deals.get(user.portal.id), contactFieldMap(this.prisma, user.portal.id), this.deals.resolved(user.portal.id, user.client), this.prisma.portalSettings.findUnique({ where: { portalId: user.portal.id } }),
    ]);
    return { definitions: SYSTEM_FIELDS, systemUserIds: systemUserIds(settings?.contactSystemUserIds), fields: { deal: crmFieldInfos(deal.result ?? {}), contact: crmFieldInfos(contact.result ?? {}) }, mappings: { deal: dealMap, contact: contactMap }, resolved: { deal: resolvedDeals, contact: resolveContactFields(crmFieldInfos(contact.result ?? {}), contactMap) } };
  }

  async save(user: B24UserContext, body: SystemFieldsDto['mappings'] & { systemUserIds?: number[] }): Promise<SystemFieldsDto> {
    const current = await this.get(user);
    for (const entity of ['deal', 'contact'] as const) {
      for (const [key, code] of Object.entries(body[entity])) {
        const oldMap: Record<string, string | undefined> = current.mappings[entity];
        // Прежние связи сохраняем, даже если тип изменили в CRM: они показываются текстом.
        if (oldMap[key] === code) continue;
        const definition = SYSTEM_FIELDS.find(f => f.entity === entity && f.key === key);
        const field = current.fields[entity].find(f => f.code === code);
        if (!definition || !field || !systemFieldCompatible(definition, field)) throw new BadRequestException({ code: 'INCOMPATIBLE_FIELD', message: `Поле «${definition?.label ?? key}»: выберите существующее совместимое поле Битрикс24` });
        if (Object.entries(body[entity]).some(([other, target]) => other !== key && target === code)) throw new BadRequestException({ code: 'DUPLICATE_FIELD', message: `Поле «${field.label}» уже используется в другом сопоставлении` });
      }
    }
    const config = body.systemUserIds === undefined ? {} : { contactSystemUserIds: body.systemUserIds };
    await this.prisma.portalSettings.upsert({ where: { portalId: user.portal.id }, create: { portalId: user.portal.id, dealFieldMap: body.deal, contactFieldMap: body.contact, ...config, updatedByUserId: user.userId }, update: { dealFieldMap: body.deal, contactFieldMap: body.contact, ...config, updatedByUserId: user.userId } });
    await this.actions?.user(user, { action: 'fields.mappings.updated', summary: 'Изменил сопоставления полей приложения с Битрикс24', entityType: 'settings', details: { before: { ...current.mappings, systemUserIds: current.systemUserIds ?? [] }, after: { ...body, systemUserIds: body.systemUserIds ?? current.systemUserIds ?? [] } } });
    return this.get(user);
  }

  /** Сначала ищем уже существующее поле; новое создаётся только по явной кнопке администратора. */
  async create(user: B24UserContext, entity: 'deal' | 'contact', key: string): Promise<SystemFieldsDto> {
    const definition = SYSTEM_FIELDS.find(f => f.entity === entity && f.key === key);
    if (!definition?.defaultCode) throw new BadRequestException('Неизвестное системное поле');
    let state = await this.get(user);
    const existing = state.fields[entity].find(f => f.code === definition.defaultCode || f.label.trim().toLocaleLowerCase('ru') === definition.label.toLocaleLowerCase('ru'));
    let code = existing?.code ?? definition.defaultCode;
    if (Object.entries(state.mappings[entity]).some(([role, target]) => role !== key && target === code)) throw new BadRequestException('Поле уже используется для другой роли');
    if (existing && !systemFieldCompatible(definition, existing)) throw new BadRequestException('Поле с таким названием уже существует, но имеет несовместимый тип');
    if (!existing) {
      try {
        await user.client.call(`crm.${entity}.userfield.add`, { fields: { FIELD_NAME: code.slice('UF_CRM_'.length), USER_TYPE_ID: definition.types[0], MULTIPLE: definition.multiple ? 'Y' : 'N', MANDATORY: 'N', XML_ID: `btx24.${entity}.${key}`, LABEL: definition.label, EDIT_FORM_LABEL: { ru: definition.label }, LIST_COLUMN_LABEL: { ru: definition.label }, SHOW_FILTER: 'Y' } });
      } catch (error) {
        state = await this.get(user);
        const raced = state.fields[entity].find(f => f.code === code && systemFieldCompatible(definition, f));
        if (!raced) throw error;
        code = raced.code;
      }
    }
    // Только связь поля, данные карточек здесь никогда не записываются.
    const next = { ...state.mappings[entity], [key]: code };
    if (entity === 'deal') await this.deals.save(user.portal.id, user.userId, next);
    else await this.prisma.portalSettings.upsert({ where: { portalId: user.portal.id }, create: { portalId: user.portal.id, contactFieldMap: next, updatedByUserId: user.userId }, update: { contactFieldMap: next, updatedByUserId: user.userId } });
    await this.actions?.user(user, { action: existing ? 'fields.matched' : 'fields.created', summary: `${existing ? 'Сопоставил' : 'Создал'} поле «${definition.label}» в Битрикс24`, entityType: 'settings', details: { entity, key, code } });
    return this.get(user);
  }
}

export const systemUserIds = (value: unknown): number[] => Array.isArray(value) ? value.filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0) : [];
