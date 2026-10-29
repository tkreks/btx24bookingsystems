import { DEAL_FIELD_ROLES, type DealFieldRole, type DealFieldMapDto } from './bookings.js';
import type { DealFieldInfo } from './group-admin.js';

export type ContactFieldMapDto = Partial<Record<'telegram' | 'whatsapp' | 'max' | 'whatsappLid' | 'telegramLogin' | 'maxLogin', string>>;
export interface SystemFieldDefinition {
  key: string;
  entity: 'deal' | 'contact';
  label: string;
  group: string;
  types: string[];
  multiple: boolean;
  defaultCode?: string;
}
const typesForRole = (role: DealFieldRole): string[] => {
  if (['bookingStart', 'bookingEnd'].includes(role)) return ['datetime', 'string'];
  if (['visitDateStart', 'visitDateEnd'].includes(role)) return ['date', 'string'];
  if (['bookingId', 'prepaymentInvoiceId', 'surchargeInvoiceId', 'guests', 'programGuests'].includes(role)) return ['integer', 'string'];
  if (['prepayment', 'surcharge'].includes(role)) return ['money', 'double', 'integer', 'string'];
  if (['prepaymentAmount', 'paidAmount'].includes(role)) return ['money', 'string'];
  if (['prepaymentLink', 'surchargeLink'].includes(role)) return ['url', 'string'];
  if (['bookingType', 'dealType'].includes(role)) return ['enumeration', 'string'];
  return ['string'];
};
export const SYSTEM_FIELDS: SystemFieldDefinition[] = [
  ...(Object.keys(DEAL_FIELD_ROLES) as DealFieldRole[]).map(key => ({ key, entity: 'deal' as const, label: DEAL_FIELD_ROLES[key], group: key.startsWith('visit') ? 'Визит' : /prepayment|surcharge|paidAmount/.test(key) ? 'Оплаты' : 'Бронирование', defaultCode: `UF_CRM_BTX24_${key.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`, types: typesForRole(key), multiple: false })),
  ...(['telegram', 'whatsapp', 'max'] as const).map(key => ({ key, entity: 'contact' as const, group: 'Контакт и мессенджеры', label: key === 'whatsapp' ? 'Адреса WhatsApp' : `${{ telegram: 'Telegram', whatsapp: 'WhatsApp', max: 'MAX' }[key]} ID`, types: ['string'], multiple: key === 'whatsapp', defaultCode: `UF_CRM_BTX24_${key.toUpperCase()}_ID` })),
];
SYSTEM_FIELDS.push(
  ...([{ key: 'whatsappLid', label: 'WhatsApp LID', suffix: 'WHATSAPP_LID' }, { key: 'telegramLogin', label: 'Логин Telegram', suffix: 'TELEGRAM_LOGIN' }, { key: 'maxLogin', label: 'Логин MAX', suffix: 'MAX_LOGIN' }]).map(f => ({ key: f.key, entity: 'contact' as const, group: 'Контакт и мессенджеры', label: f.label, types: ['string'], multiple: false, defaultCode: `UF_CRM_BTX24_${f.suffix}` })),
);
export const CRM_FIELD_TYPES: Record<string, string> = { string: 'Строка', integer: 'Целое число', double: 'Число', money: 'Деньги', date: 'Дата', datetime: 'Дата и время', enumeration: 'Список', boolean: 'Да/нет', url: 'Ссылка', file: 'Файл', employee: 'Сотрудник', user: 'Сотрудник', crm: 'Привязка к CRM', address: 'Адрес' };
export function systemFieldCompatible(system: SystemFieldDefinition, field: DealFieldInfo): boolean {
  return !field.readOnly && field.code.startsWith('UF_CRM_') && field.multiple === system.multiple && system.types.includes(field.type);
}
export interface SystemFieldsDto {
  definitions: SystemFieldDefinition[];
  systemUserIds?: number[];
  fields: { deal: DealFieldInfo[]; contact: DealFieldInfo[] };
  mappings: { deal: DealFieldMapDto; contact: ContactFieldMapDto };
  resolved: { deal: DealFieldMapDto; contact: ContactFieldMapDto };
}

export const CONTACT_FIELD_CANDIDATES: Record<string, string[]> = {
  telegram: ['UF_CRM_BTX24_TELEGRAM_ID', 'UF_CRM_TELEGRAMID_WZ'],
  whatsapp: ['UF_CRM_BTX24_WHATSAPP_ID'],
  max: ['UF_CRM_BTX24_MAX_ID', 'UF_CRM_MAXID_WZ'],
  whatsappLid: ['UF_CRM_BTX24_WHATSAPP_LID', 'UF_CRM_WHATSAPPLID_WZ'],
  telegramLogin: ['UF_CRM_BTX24_TELEGRAM_LOGIN', 'UF_CRM_TELEGRAMUSERNAME_WZ'],
  maxLogin: ['UF_CRM_BTX24_MAX_LOGIN', 'UF_CRM_MAXUSERNAME_WZ'],
};
export function resolveContactFields(fields: DealFieldInfo[], saved: ContactFieldMapDto): ContactFieldMapDto {
  const result = { ...saved };
  for (const definition of SYSTEM_FIELDS.filter(f => f.entity === 'contact')) {
    const key = definition.key as keyof ContactFieldMapDto;
    if (result[key]) continue;
    const candidates = CONTACT_FIELD_CANDIDATES[key] ?? [];
    const found = candidates.map(code => fields.find(f => f.code === code && systemFieldCompatible(definition, f))).find(Boolean);
    if (found) result[key] = found.code;
  }
  return result;
}
