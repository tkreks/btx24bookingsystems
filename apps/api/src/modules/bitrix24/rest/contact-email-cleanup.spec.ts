import { ContactEmailCleanupGrant } from './rest-client.js';

describe('ContactEmailCleanupGrant', () => {
  const grant = new ContactEmailCleanupGrant(140);
  const ok = { id: 140, fields: { EMAIL: [{ ID: '12', VALUE: '' }] } };

  it('пропускает только удаление e-mail по ID у своего контакта', () => {
    expect(() => grant.check('crm.contact.update', ok)).not.toThrow();
  });

  it.each([
    ['другой метод', 'crm.contact.delete', ok],
    ['другой контакт', 'crm.contact.update', { ...ok, id: 141 }],
    ['другое поле', 'crm.contact.update', { id: 140, fields: { NAME: 'x' } }],
    ['EMAIL вместе с другим полем', 'crm.contact.update', { id: 140, fields: { EMAIL: [{ ID: '1', VALUE: '' }], NAME: 'x' } }],
    ['новое значение вместо удаления', 'crm.contact.update', { id: 140, fields: { EMAIL: [{ ID: '1', VALUE: 'a@b.ru' }] } }],
    ['значение без ID', 'crm.contact.update', { id: 140, fields: { EMAIL: [{ VALUE: '' }] } }],
    ['пустой список', 'crm.contact.update', { id: 140, fields: { EMAIL: [] } }],
  ])('отклоняет: %s', (_n, method, params) => {
    expect(() => grant.check(method, params as Record<string, unknown>)).toThrow(/CONTACT_WRITE_DISABLED|Очистка e-mail/);
  });
});
