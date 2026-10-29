import { MessengerCrmService } from './messenger-crm.service.js';
import type { Messenger } from '../../generated/prisma/client.js';
import { contactFieldMap, mappedContactField } from '../bitrix24/contact-field-map.js';
it.each(['telegram', 'whatsapp', 'max'])('не редактирует контакт и не создаёт поля автоматически: %s', async kind => {
  const call = vi.fn();
  const crm = new MessengerCrmService({} as never, { clientFor: () => ({ call }) } as never);
  await crm.syncContactIdentity({ id: 'm1', portalId: 'p1', kind } as Messenger, '123@lid', 7);
  expect(call).not.toHaveBeenCalled();
});
it('сопоставления контактов изолированы по порталу', async () => {
  const read = vi.fn(async ({ where }: { where: { portalId: string } }) => ({ contactFieldMap: where.portalId === 'p1' ? { max: 'UF_CRM_EXISTING' } : {} }));
  const db = { portalSettings: { findUnique: read } } as never;
  expect(mappedContactField('max', await contactFieldMap(db, 'p1'))).toBe('UF_CRM_EXISTING');
  expect(mappedContactField('max', await contactFieldMap(db, 'p2'))).toBe('UF_CRM_BTX24_MAX_ID');
});
