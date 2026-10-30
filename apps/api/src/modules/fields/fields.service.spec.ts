import { FieldsService, crmFieldInfos, type CrmFieldMeta } from './fields.service.js';
import { FieldsController } from './fields.controller.js';

function setup() {
  const write = vi.fn(async () => ({}));
  const read = vi.fn(async ({ where }: { where: { portalId: string } }) => ({ contactFieldMap: where.portalId === 'p1' ? { telegram: 'UF_CRM_TG' } : {} }));
  const call = vi.fn(async (method: string): Promise<{ result: Record<string, CrmFieldMeta> }> => ({ result: method === 'crm.contact.fields' ? {
    UF_CRM_TG: { type: 'string', formLabel: 'Telegram клиента', isMultiple: false },
    UF_CRM_WRONG: { type: 'integer', isMultiple: false },
    UF_CRM_MANY: { type: 'string', isMultiple: true },
  } : { UF_CRM_START: { type: 'datetime', formLabel: 'Заезд' }, UF_CRM_READ: { type: 'string', isReadOnly: true } } }));
  const service = new FieldsService({ portalSettings: { findUnique: read, upsert: write } } as never, { get: async () => ({}), resolved: async () => ({ bookingStart: 'UF_CRM_START' }) } as never);
  const user = { portal: { id: 'p1' }, userId: 9, client: { call } } as never;
  return { service, user, read, write, call };
}
it('читает справочники токеном сотрудника и настройки только его портала', async () => {
  const t = setup();
  const result = await t.service.get(t.user);
  expect(t.call.mock.calls.map(c => c[0])).toEqual(['crm.deal.fields', 'crm.contact.fields']);
  expect(t.read).toHaveBeenCalledWith({ where: { portalId: 'p1' } });
  expect(result.mappings.contact.telegram).toBe('UF_CRM_TG');
  expect(result.resolved.deal.bookingStart).toBe('UF_CRM_START');
  const other = await t.service.get({ ...t.user as object, portal: { id: 'p2' } } as never);
  expect(other.mappings.contact).toEqual({});
});
it('сохраняет обе карты одним запросом, без записи в CRM', async () => {
  const t = setup();
  await t.service.save(t.user, { deal: { bookingStart: 'UF_CRM_START' }, contact: { telegram: 'UF_CRM_TG', whatsapp: 'UF_CRM_MANY' } });
  expect(t.write).toHaveBeenCalledWith(expect.objectContaining({ where: { portalId: 'p1' }, update: expect.objectContaining({ contactFieldMap: { telegram: 'UF_CRM_TG', whatsapp: 'UF_CRM_MANY' }, updatedByUserId: 9 }) }));
  expect(t.call.mock.calls.some(([m]) => m.includes('update'))).toBe(false);
});
it.each([
  { deal: {}, contact: { telegram: 'UF_CRM_WRONG' } },
  { deal: {}, contact: { telegram: 'UF_CRM_MANY' } },
  { deal: {}, contact: { whatsapp: 'UF_CRM_TG' } },
  { deal: { bookingStart: 'UF_CRM_READ' }, contact: {} },
  { deal: {}, contact: { telegram: 'UF_CRM_MISSING' } },
  { deal: {}, contact: { telegram: 'UF_CRM_TG', max: 'UF_CRM_TG' } },
])('отклоняет несовместимые, недоступные и повторные поля: %o', async body => {
  const t = setup();
  await expect(t.service.save(t.user, body)).rejects.toMatchObject({ status: 400 });
  expect(t.write).not.toHaveBeenCalled();
});
it('контроллер отклоняет чужой portalId и неизвестную сущность до сервиса', () => {
  const t = setup();
  const controller = new FieldsController(t.service);
  expect(() => controller.save(t.user, { portalId: 'p2', deal: {}, contact: {} })).toThrow();
  expect(() => controller.save(t.user, { deal: {}, contact: { unknown: 'UF_CRM_TG' } })).toThrow();
});
it('метаданные кратности корректно читаются и строками Y/N', () => {
  expect(crmFieldInfos({ UF: { type: 'string', isReadOnly: 'N', isMultiple: 'N' } })[0]).toMatchObject({ multiple: false, readOnly: false });
});

it('существующее совместимое поле сопоставляется без создания дубля и без изменения контакта', async () => {
  const t = setup();
  t.call.mockImplementation(async (method: string): Promise<{ result: Record<string, CrmFieldMeta> }> => ({ result: method === 'crm.contact.fields' ? { UF_CRM_TG: { type: 'string', formLabel: 'Telegram ID', isMultiple: false } } : {} }));
  await t.service.create(t.user, 'contact', 'telegram');
  expect(t.call.mock.calls.some(([method]) => method.endsWith('.add') || method.endsWith('.update'))).toBe(false);
  expect(t.write).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ contactFieldMap: { telegram: 'UF_CRM_TG' } }) }));
});

it('прежнее сопоставление сохраняется при изменившемся типе CRM, не мешая новым связям', async () => {
  const t = setup();
  // В старых настройках это поле уже использовалось: переносить или удалять его нельзя.
  const service = new FieldsService({ portalSettings: { findUnique: t.read, upsert: t.write } } as never, { get: async () => ({ bookingStart: 'UF_CRM_READ' }), resolved: async () => ({ bookingStart: 'UF_CRM_READ' }) } as never);
  await service.save(t.user, { deal: { bookingStart: 'UF_CRM_READ' }, contact: { telegram: 'UF_CRM_TG' } });
  expect(t.write).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ dealFieldMap: { bookingStart: 'UF_CRM_READ' } }) }));
});

it('«Брони сделки» создаётся по кнопке множественным строковым полем и сопоставляется; существующее одиночное — не подходит', async () => {
  const t = setup();
  const save = vi.fn(async () => ({}));
  const service = new FieldsService({ portalSettings: { findUnique: t.read, upsert: t.write } } as never, { get: async () => ({}), resolved: async () => ({}), save } as never);
  await service.create(t.user, 'deal', 'bookingsList');
  const add = t.call.mock.calls.find(([m]) => m === 'crm.deal.userfield.add') as unknown as [string, { fields: Record<string, unknown> }];
  expect(add[1].fields).toMatchObject({ FIELD_NAME: 'BTX24_BOOKINGS_LIST', USER_TYPE_ID: 'string', MULTIPLE: 'Y', MANDATORY: 'N', XML_ID: 'btx24.deal.bookingsList', LABEL: 'Брони сделки' });
  expect(save).toHaveBeenCalledWith('p1', 9, { bookingsList: 'UF_CRM_BTX24_BOOKINGS_LIST' });

  t.call.mockImplementation(async (method: string): Promise<{ result: Record<string, CrmFieldMeta> }> => ({ result: method === 'crm.deal.fields' ? { UF_CRM_LIST: { type: 'string', formLabel: 'Брони сделки', isMultiple: false } } : {} }));
  await expect(service.create(t.user, 'deal', 'bookingsList')).rejects.toMatchObject({ status: 400 });
});
