import { Bitrix24RestClient, type AccessProvider } from './rest-client.js';
import { Bitrix24Error } from './errors.js';
import { RateLimiter } from './rate-limiter.js';
import { requestContext } from '../../../common/cache-invalidation.js';

type Reply = { status?: number; body: unknown } | Error;

function setup(replies: Reply[], access?: Partial<AccessProvider>) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const r = replies.shift();
    if (!r) throw new Error('no more replies');
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  });
  const provider: AccessProvider = {
    getAccessToken: vi.fn(async () => 'tok-1'),
    refresh: vi.fn(async () => 'tok-2'),
    ...access,
  };
  const client = new Bitrix24RestClient({
    clientEndpoint: 'https://portal.example/rest/',
    access: provider,
    limiter: new RateLimiter(1000, 1000),
    limiterKey: 'm1',
    fetch: fetchMock as unknown as typeof fetch,
    sleep: async () => undefined,
  });
  return { client, calls, provider };
}

describe('Bitrix24RestClient.call', () => {
  it('does not send reads for a client that has gone, but finishes writes', async () => {
    const { client, calls } = setup([{ body: { result: 5 } }]);
    const gone = { res: {} as never, closed: true };
    await expect(requestContext.run(gone, () => client.call('crm.deal.list'))).rejects.toMatchObject({ code: 'CLIENT_GONE' });
    await expect(requestContext.run(gone, () => client.batch({ a: { method: 'crm.deal.get', params: { id: 1 } } }))).rejects.toMatchObject({ code: 'CLIENT_GONE' });
    expect(calls).toHaveLength(0);
    await expect(requestContext.run(gone, () => client.call('crm.deal.add', { fields: {} }))).resolves.toMatchObject({ result: 5 });
  });

  it('posts JSON with auth to <endpoint><method>.json', async () => {
    const { client, calls } = setup([{ body: { result: { ID: 1 }, total: 1 } }]);
    const res = await client.call('crm.deal.get', { id: 1 });
    expect(res).toEqual({ result: { ID: 1 }, total: 1, next: undefined });
    expect(calls[0]).toEqual({ url: 'https://portal.example/rest/crm.deal.get.json', body: { id: 1, auth: 'tok-1' } });
  });

  it('refreshes once on expired_token and retries with the new token', async () => {
    const { client, calls, provider } = setup([{ status: 401, body: { error: 'expired_token' } }, { body: { result: true } }]);
    await expect(client.call('user.admin')).resolves.toMatchObject({ result: true });
    expect(provider.refresh).toHaveBeenCalledWith('tok-1');
    expect(calls[1].body.auth).toBe('tok-2');
  });

  it('does not loop when the refreshed token is also rejected', async () => {
    const { client } = setup([
      { status: 401, body: { error: 'expired_token' } },
      { status: 401, body: { error: 'expired_token', error_description: 'still expired' } },
    ]);
    await expect(client.call('user.admin')).rejects.toMatchObject({ code: 'expired_token' });
  });

  it('retries QUERY_LIMIT_EXCEEDED, then gives up', async () => {
    const limit = { status: 503, body: { error: 'QUERY_LIMIT_EXCEEDED' } };
    const ok = setup([limit, limit, { body: { result: 1 } }]);
    await expect(ok.client.call('app.info')).resolves.toMatchObject({ result: 1 });

    const fail = setup(Array.from({ length: 6 }, () => ({ ...limit })));
    await expect(fail.client.call('app.info')).rejects.toBeInstanceOf(Bitrix24Error);
  });

  it('never retries a network error (a write could be duplicated)', async () => {
    const { client, calls } = setup([new Error('socket hang up'), { body: { result: 1 } }]);
    await expect(client.call('booking.v1.booking.add', {})).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(calls).toHaveLength(1);
  });

  it('maps REST errors and non-JSON answers to Bitrix24Error', async () => {
    const { client } = setup([{ status: 400, body: { error: 'ACCESS_DENIED', error_description: 'nope' } }]);
    await expect(client.call('crm.deal.get')).rejects.toMatchObject({ code: 'ACCESS_DENIED', message: 'nope', httpStatus: 400 });

    const html = setup([]);
    (html.client as unknown as { fetchImpl: typeof fetch }).fetchImpl = (async () => new Response('<html>', { status: 502 })) as typeof fetch;
    await expect(html.client.call('app.info')).rejects.toMatchObject({ code: 'ERROR_UNEXPECTED_ANSWER' });
  });

  it('rejects malformed method names before any request', async () => {
    const { client, calls } = setup([]);
    await expect(client.call('../profile')).rejects.toMatchObject({ code: 'INVALID_METHOD' });
    expect(calls).toHaveLength(0);
  });
});

describe('Bitrix24RestClient.batch', () => {
  it('encodes commands and normalizes empty error arrays', async () => {
    const { client, calls } = setup([{ body: { result: { result: { a: 1, b: [2] }, result_error: [], result_total: [], result_next: [] } } }]);
    const res = await client.batch({ a: { method: 'app.info' }, b: { method: 'crm.deal.list', params: { select: ['ID'] } } });
    expect(res).toEqual({ result: { a: 1, b: [2] }, errors: {}, total: {}, next: {} });
    expect(calls[0].body.cmd).toEqual({ a: 'app.info', b: 'crm.deal.list?select%5B0%5D=ID' });
    expect(calls[0].body.halt).toBe(0);
  });

  it('splits more than 50 independent commands into several requests', async () => {
    const page = { body: { result: { result: {}, result_error: [] } } };
    const { client, calls } = setup([page, page]);
    const cmds = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`c${i}`, { method: 'app.info' }]));
    await client.batch(cmds);
    expect(calls).toHaveLength(2);
    expect(Object.keys(calls[0].body.cmd as object)).toHaveLength(50);
  });

  it('refuses to split a batch that uses $result references', async () => {
    const { client } = setup([]);
    const cmds = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`c${i}`, { method: 'crm.deal.get', params: { id: '$result[c0][ID]' } }]));
    await expect(client.batch(cmds)).rejects.toMatchObject({ code: 'BATCH_TOO_LARGE' });
  });
});

describe('Bitrix24RestClient.listAll', () => {
  it('follows next until the last page', async () => {
    const { client, calls } = setup([{ body: { result: [1, 2], next: 2 } }, { body: { result: [3] } }]);
    await expect(client.listAll('crm.deal.list')).resolves.toEqual([1, 2, 3]);
    expect(calls.map((c) => c.body.start)).toEqual([0, 2]);
  });
});

describe('Bitrix24RestClient.download', () => {
  const make = (body: string, headers: Record<string, string> = {}) => {
    const fetchMock = vi.fn(async () => new Response(body, { status: 200, headers }));
    const client = new Bitrix24RestClient({
      clientEndpoint: 'https://portal.example/rest/',
      access: { getAccessToken: async () => 't', refresh: async () => 't' },
      limiter: new RateLimiter(1000, 1000),
      limiterKey: 'm1',
      fetch: fetchMock as unknown as typeof fetch,
    });
    return { client, fetchMock };
  };
  it('downloads only from the portal host and within the size limit', async () => {
    const ok = make('img', { 'content-type': 'image/jpeg' });
    expect(await ok.client.download('https://portal.example/rest/download.json?token=x')).toMatchObject({ contentType: 'image/jpeg' });
    await expect(ok.client.download('https://evil.example/x')).rejects.toMatchObject({ code: 'INVALID_DOWNLOAD_URL' });
    await expect(ok.client.download('http://portal.example/x')).rejects.toMatchObject({ code: 'INVALID_DOWNLOAD_URL' });
    await expect(make('0123456789').client.download('https://portal.example/x', 5)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });
});

describe('Bitrix24RestClient — окончательный сбой запроса сообщается наружу (журнал действий)', () => {
  it('после повторов лимита и при сети — onFailure с методом, кодом, записью и сотрудником', async () => {
    const failures: unknown[] = [];
    const limit = { status: 503, body: { error: 'QUERY_LIMIT_EXCEEDED', error_description: 'Too many requests' } };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(limit.body), { status: 503 }));
    const client = new Bitrix24RestClient({
      clientEndpoint: 'https://portal.example/rest/',
      access: { getAccessToken: async () => 't', refresh: async () => 't' },
      limiter: new RateLimiter(1000, 1000),
      limiterKey: 'm1',
      fetch: fetchMock as unknown as typeof fetch,
      sleep: async () => undefined,
      maxRateLimitRetries: 2,
      onFailure: (f) => failures.push(f),
    });
    client.actor = { userId: 7, name: 'Анна' };
    await expect(client.call('booking.v1.booking.add', {})).rejects.toMatchObject({ code: 'QUERY_LIMIT_EXCEEDED' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(failures).toEqual([{ method: 'booking.v1.booking.add', code: 'QUERY_LIMIT_EXCEEDED', message: 'Too many requests', write: true, actor: { userId: 7, name: 'Анна' } }]);
  });

  it('удачный запрос — без onFailure', async () => {
    const onFailure = vi.fn();
    const { client } = setup([{ body: { result: true } }]);
    (client as unknown as { opts: { onFailure: unknown } }).opts.onFailure = onFailure;
    await client.call('crm.deal.get', { id: 1 });
    expect(onFailure).not.toHaveBeenCalled();
  });
});

describe('Bitrix24RestClient.callV3 (REST 3.0)', () => {
  it('posts JSON with auth to <endpoint>api/<method>, returns result; token refresh on expired_token', async () => {
    const { client, calls } = setup([{ status: 401, body: { error: 'expired_token' } }, { body: { result: { items: [{ id: 1 }] } } }]);
    expect(await client.callV3('timeman.record.list', { filter: [['userId', 7]] })).toEqual({ items: [{ id: 1 }] });
    expect(calls[1]).toEqual({ url: 'https://portal.example/rest/api/timeman.record.list', body: { filter: [['userId', 7]], auth: 'tok-2' } });
  });

  it('REST 3.0 error object → Bitrix24Error with code and validation details; writes are refused', async () => {
    const { client } = setup([
      { status: 400, body: { error: { code: 'BITRIX_REST_V3_EXCEPTION_VALIDATION_REQUESTVALIDATIONEXCEPTION', message: 'Ошибка', validation: [{ field: 'filter', message: 'bad' }] } } },
    ]);
    await expect(client.callV3('timeman.record.list', {})).rejects.toMatchObject({ code: 'BITRIX_REST_V3_EXCEPTION_VALIDATION_REQUESTVALIDATIONEXCEPTION', message: 'Ошибка (filter: bad)' });
    await expect(client.callV3('tasks.task.add', {})).rejects.toBeInstanceOf(Bitrix24Error);
  });
});
