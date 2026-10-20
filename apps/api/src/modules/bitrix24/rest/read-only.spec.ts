import { isReadMethod } from './read-only.js';
import { Bitrix24RestClient } from './rest-client.js';
import { RateLimiter } from './rate-limiter.js';

describe('isReadMethod', () => {
  it.each(['booking.v1.booking.list', 'booking.v1.booking.get', 'booking.v1.booking.externalData.list', 'crm.deal.fields', 'crm.deal.productrows.get', 'crm.deal.userfield.list', 'bizproc.workflow.template.list', 'user.admin', 'user.current', 'app.info', 'event.bind', 'placement.bind'])(
    'treats %s as allowed',
    (m) => expect(isReadMethod(m)).toBe(true),
  );
  it.each(['booking.v1.booking.add', 'booking.v1.booking.update', 'booking.v1.booking.delete', 'booking.v1.booking.externalData.set', 'crm.deal.update', 'crm.deal.add', 'crm.deal.productrows.set', 'crm.contact.update', 'bizproc.workflow.start', 'crm.deal.userfield.add', 'im.message.add'])(
    'treats %s as a write',
    (m) => expect(isReadMethod(m)).toBe(false),
  );
});

describe('Bitrix24RestClient in read-only mode', () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: { result: {}, result_error: [] } })));
  const client = new Bitrix24RestClient({
    clientEndpoint: 'https://portal.example/rest/',
    access: { getAccessToken: async () => 't', refresh: async () => 't' },
    limiter: new RateLimiter(1000, 1000),
    limiterKey: 'm',
    fetch: fetchMock as unknown as typeof fetch,
    readOnly: true,
  });

  beforeEach(() => fetchMock.mockClear());

  it('blocks a write before sending anything', async () => {
    await expect(client.call('crm.deal.update', { id: 1, fields: {} })).rejects.toMatchObject({ code: 'READ_ONLY_MODE' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks a batch that hides a write among reads', async () => {
    await expect(client.batch({ a: { method: 'crm.deal.get' }, b: { method: 'booking.v1.booking.add' } })).rejects.toMatchObject({ code: 'READ_ONLY_MODE' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets reads and read-only batches through', async () => {
    await client.call('booking.v1.resource.list');
    await client.batch({ a: { method: 'crm.deal.get' }, b: { method: 'crm.category.list' } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
