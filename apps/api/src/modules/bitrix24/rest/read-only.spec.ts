import { isReadMethod } from './read-only.js';

describe('isReadMethod', () => {
  it.each(['booking.v1.booking.list', 'booking.v1.booking.get', 'booking.v1.booking.externalData.list', 'crm.deal.fields', 'crm.deal.productrows.get', 'crm.deal.userfield.list', 'bizproc.workflow.template.list', 'user.admin', 'user.current', 'user.search', 'crm.duplicate.findbycomm', 'disk.storage.getlist', 'disk.folder.getChildren', 'app.info', 'event.bind', 'placement.bind'])(
    'treats %s as allowed',
    (m) => expect(isReadMethod(m)).toBe(true),
  );
  it.each(['booking.v1.booking.add', 'booking.v1.booking.update', 'booking.v1.booking.delete', 'booking.v1.booking.externalData.set', 'crm.deal.update', 'crm.deal.add', 'crm.deal.productrows.set', 'crm.contact.update', 'bizproc.workflow.start', 'crm.deal.userfield.add', 'im.message.add'])(
    'treats %s as a write',
    (m) => expect(isReadMethod(m)).toBe(false),
  );
});
