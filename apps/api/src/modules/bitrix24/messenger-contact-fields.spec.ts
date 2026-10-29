import { contactFieldTarget, messengerIdentityOf } from './messenger-contact-fields.js';

it('не смешивает номер и LID WhatsApp, сохраняет большие ID строками', () => {
  expect(messengerIdentityOf('whatsapp', '123@lid')).toBe('123@lid');
  expect(messengerIdentityOf('whatsapp', '123@c.us')).toBe('123@c.us');
  expect(messengerIdentityOf('max', '12345678901234567890@lid')).toBe('12345678901234567890');
  expect(messengerIdentityOf('telegram', '123@g.us')).toBeNull();
  expect(messengerIdentityOf('max', '123@c.us')).toBeNull();
  expect(messengerIdentityOf('unknown', '123@lid')).toBeNull();
});
it('восстанавливает адреса всех мессенджеров из полей контакта', () => {
  expect(contactFieldTarget('whatsapp', ['invalid', '123@c.us', '456@lid'])).toBe('123@c.us');
  expect(contactFieldTarget('max', '456')).toBe('456@lid');
  expect(contactFieldTarget('telegram', '789')).toBe('789@lid');
  expect(contactFieldTarget('max', '456@g.us')).toBeNull();
});
