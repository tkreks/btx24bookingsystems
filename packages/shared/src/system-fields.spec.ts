import { it, expect } from 'vitest';
import { SYSTEM_FIELDS, resolveContactFields, systemFieldCompatible } from './system-fields.js';
const meta = { code: 'UF_CRM_TEST', label: 'Тест', type: 'string', multiple: false, readOnly: false };
it('ID мессенджеров сохраняются строками, а WhatsApp требует множественного поля', () => {
  const tg = SYSTEM_FIELDS.find(f => f.entity === 'contact' && f.key === 'telegram')!;
  const wa = SYSTEM_FIELDS.find(f => f.entity === 'contact' && f.key === 'whatsapp')!;
  expect(systemFieldCompatible(tg, meta)).toBe(true);
  expect(systemFieldCompatible(tg, { ...meta, type: 'integer' })).toBe(false);
  expect(systemFieldCompatible(wa, meta)).toBe(false);
  expect(systemFieldCompatible(wa, { ...meta, multiple: true })).toBe(true);
  expect(systemFieldCompatible(tg, { ...meta, readOnly: true })).toBe(false);
  expect(systemFieldCompatible(tg, { ...meta, code: 'NAME' })).toBe(false);
});
it('поля даты допускают дату/строку, а дату-время — дату-время/строку', () => {
  const start = SYSTEM_FIELDS.find(f => f.key === 'bookingStart')!;
  expect(systemFieldCompatible(start, { ...meta, type: 'datetime' })).toBe(true);
  expect(systemFieldCompatible(start, { ...meta, type: 'date' })).toBe(false);
});

it('находит реальные собственные и старые поля, не притворяется, что множественный WhatsApp уже создан', () => {
  const fields = [
    { ...meta, code: 'UF_CRM_BTX24_TELEGRAM_ID' },
    { ...meta, code: 'UF_CRM_TELEGRAMID_WZ' },
    { ...meta, code: 'UF_CRM_MAXID_WZ' },
    { ...meta, code: 'UF_CRM_WHATSAPPLID_WZ' },
  ];
  expect(resolveContactFields(fields, {})).toEqual({ telegram: 'UF_CRM_BTX24_TELEGRAM_ID', max: 'UF_CRM_MAXID_WZ', whatsappLid: 'UF_CRM_WHATSAPPLID_WZ' });
  expect(resolveContactFields(fields, { telegram: 'UF_CRM_CUSTOM' }).telegram).toBe('UF_CRM_CUSTOM');
});
