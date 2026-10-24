import { afterEach, describe, expect, it, vi } from 'vitest';

type Auth = { access_token: string; member_id: string; domain: string; expires_in?: number } | false;

/** Свежий модуль b24.ts с поддельным BX24 SDK. */
async function load(sdk: { getAuth: () => Auth; refreshAuth: (cb: (a: Auth) => void) => void }) {
  vi.resetModules();
  (globalThis as unknown as { window: unknown }).window = { BX24: sdk };
  return import('./b24.js');
}

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('getAuth', () => {
  it('uses the frame token while it is fresh', async () => {
    const refreshAuth = vi.fn();
    const b24 = await load({ getAuth: () => ({ access_token: 't1', member_id: 'm', domain: 'd', expires_in: 3600 }), refreshAuth });
    expect(await b24.getAuth()).toEqual({ token: 't1', memberId: 'm' });
    expect(refreshAuth).not.toHaveBeenCalled();
  });

  it('after long idle (getAuth() === false) asks the portal for a new token instead of failing', async () => {
    const b24 = await load({ getAuth: () => false, refreshAuth: (cb) => cb({ access_token: 't2', member_id: 'm', domain: 'd', expires_in: 3600 }) });
    expect(await b24.getAuth()).toEqual({ token: 't2', memberId: 'm' });
  });

  it('refreshes ahead of expiry, and concurrent callers share one refresh', async () => {
    vi.useFakeTimers();
    let n = 0;
    const refreshAuth = vi.fn((cb: (a: Auth) => void) => setTimeout(() => cb({ access_token: `r${++n}`, member_id: 'm', domain: 'd', expires_in: 3600 }), 10));
    const b24 = await load({ getAuth: () => ({ access_token: 't1', member_id: 'm', domain: 'd', expires_in: 3600 }), refreshAuth });
    await b24.getAuth();
    vi.advanceTimersByTime(56 * 60_000); // осталось 4 минуты
    const both = Promise.all([b24.getAuth(), b24.getAuth()]);
    await vi.advanceTimersByTimeAsync(20);
    expect(await both).toEqual([{ token: 'r1', memberId: 'm' }, { token: 'r1', memberId: 'm' }]);
    expect(refreshAuth).toHaveBeenCalledTimes(1);
  });

  it('gives up when the portal never answers', async () => {
    vi.useFakeTimers();
    const b24 = await load({ getAuth: () => false, refreshAuth: () => {} });
    const p = b24.getAuth();
    const check = expect(p).rejects.toThrow('Портал не ответил');
    await vi.advanceTimersByTimeAsync(16_000);
    await check;
  });
});

describe('screenFrameHeight', () => {
  it('вкладка сделки — окно браузера без шапки портала и слайдера', async () => {
    const { screenFrameHeight } = await import('./b24.js');
    expect(screenFrameHeight(1100, 'CRM_DEAL_DETAIL_TAB')).toBe(720);
    expect(screenFrameHeight(1000, 'DEFAULT')).toBe(780);
  });
  it('не ниже 560 px на маленьком окне', async () => {
    const { screenFrameHeight } = await import('./b24.js');
    expect(screenFrameHeight(600, 'CRM_DEAL_DETAIL_TAB')).toBe(560);
  });
});


describe('чат на конкретном сообщении и контекст CALL_CARD', () => {
  it('сообщение открывает полным путём с IM_MESSAGE, а не обычным openMessenger', async () => {
    const b24 = await load({ getAuth: () => false, refreshAuth: () => {} });
    const openPath = vi.fn();
    const openMessenger = vi.fn();
    Object.assign(window.BX24!, { openPath, im: { openMessenger } });
    const open = vi.fn();
    Object.assign(window, { open });
    b24.setPortalDomain('example.test');
    b24.openMessenger(4396, 123456);
    expect(open).toHaveBeenCalledWith('https://example.test/online/?IM_DIALOG=chat4396&IM_MESSAGE=123456', '_blank', 'noopener');
    expect(openPath).not.toHaveBeenCalled();
    expect(openMessenger).not.toHaveBeenCalled();
  });
  it('поздний контекст звонка читает через getStatus', async () => {
    const b24 = await load({ getAuth: () => false, refreshAuth: () => {} });
    const call = vi.fn((_command, _params, cb) => cb({ CALL_ID: 'new-call', PHONE_NUMBER: '+70000000000', CRM_ENTITY_TYPE: 'CONTACT', CRM_ENTITY_ID: 140 }));
    Object.assign(window.BX24!, { placement: { call } });
    expect(await b24.readCallContext(undefined)).toMatchObject({ callId: 'new-call', entityType: 'CONTACT', entityId: '140' });
    expect(call).toHaveBeenCalledWith('getStatus', {}, expect.any(Function));
  });
  it('не оставляет ожидание навсегда, если getStatus не ответил', async () => {
    vi.useFakeTimers();
    const b24 = await load({ getAuth: () => false, refreshAuth: () => {} });
    Object.assign(window.BX24!, { placement: { call: () => {} } });
    const previous = { callId: 'initial', phone: null, entityType: null, entityId: null, direction: null };
    const result = b24.readCallContext(previous);
    await vi.advanceTimersByTimeAsync(2600);
    expect(await result).toEqual(previous);
  });
});
