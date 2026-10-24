import { describe, expect, it, vi } from 'vitest';
import { invalidate, SwrCache } from './swr-cache.js';
import { tagsForEvent, tagsForRequest } from './cache-invalidation.js';

const opts = { freshMs: 1000, staleMs: 10_000, scope: 'm1', tags: ['calls'] as const };

describe('SwrCache', () => {
  it('свежий ответ — без пересчёта, устаревший — сразу и пересчёт в фоне', async () => {
    let t = 0;
    const cache = new SwrCache<number>(10, () => t);
    let n = 0;
    const compute = vi.fn(async () => ++n);
    expect(await cache.get('k', compute, opts)).toEqual({ value: 1, meta: { state: 'miss', ageMs: 0, refreshing: false } });
    t = 500;
    expect(await cache.get('k', compute, opts)).toEqual({ value: 1, meta: { state: 'fresh', ageMs: 500, refreshing: false } });
    expect(compute).toHaveBeenCalledTimes(1);
    t = 2000;
    expect(await cache.get('k', compute, opts)).toEqual({ value: 1, meta: { state: 'stale', ageMs: 2000, refreshing: true } });
    expect(compute).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    expect((await cache.get('k', compute, opts)).value).toBe(2);
  });

  it('совсем старый ответ — ждём пересчёт', async () => {
    let t = 0;
    const cache = new SwrCache<number>(10, () => t);
    let n = 0;
    await cache.get('k', async () => ++n, opts);
    t = 20_000;
    expect((await cache.get('k', async () => ++n, opts)).value).toBe(2);
  });

  it('сброс касается только своих разделов и своего портала', async () => {
    const cache = new SwrCache<number>(10, () => 0);
    let n = 0;
    const calls = { ...opts, tags: ['calls'] as const };
    const chats = { ...opts, tags: ['chats'] as const };
    await cache.get('calls', async () => ++n, calls);
    await cache.get('chats', async () => ++n, chats);
    invalidate('m1', ['chats']);
    expect((await cache.get('calls', async () => ++n, calls)).meta.state).toBe('fresh');
    expect((await cache.get('chats', async () => ++n, chats)).meta.state).toBe('miss');
    invalidate('m2', 'all');
    expect((await cache.get('calls', async () => ++n, calls)).meta.state).toBe('fresh');
    // Права (access) и сброс без портала затрагивают всё.
    invalidate(null, ['access']);
    expect((await cache.get('calls', async () => ++n, calls)).meta.state).toBe('miss');
  });

  it('одновременные запросы считаются один раз, ошибка не запоминается', async () => {
    const cache = new SwrCache<number>(10, () => 0);
    const compute = vi.fn(async () => 7);
    const [a, b] = await Promise.all([cache.get('k', compute, opts), cache.get('k', compute, opts)]);
    expect([a.value, b.value]).toEqual([7, 7]);
    expect(compute).toHaveBeenCalledTimes(1);
    await expect(cache.get('e', async () => Promise.reject(new Error('x')), opts)).rejects.toThrow('x');
    expect((await cache.get('e', async () => 1, opts)).value).toBe(1);
  });
});

describe('что сбрасывает изменение', () => {
  it('запросы приложения', () => {
    expect(tagsForRequest('GET', '/api/bookings')).toBeNull();
    expect(tagsForRequest('POST', '/api/activity/enter')).toBeNull();
    expect(tagsForRequest('PUT', '/api/dashboard/layout')).toBeNull();
    expect(tagsForRequest('POST', '/api/bookings/5/cancel')).toEqual(['bookings', 'deals', 'activity']);
    expect(tagsForRequest('POST', '/api/openlines/chats/7/messages')).toEqual(['chats', 'activity']);
    expect(tagsForRequest('PUT', '/api/admin/groups/g1')).toBe('all');
  });
  it('события Битрикс24', () => {
    expect(tagsForEvent('ONBOOKINGADD')).toEqual(['bookings', 'deals']);
    expect(tagsForEvent('ONCRMDEALUPDATE')).toEqual(['deals', 'bookings']);
    expect(tagsForEvent('ONVOXIMPLANTCALLEND')).toEqual(['calls', 'activity']);
    expect(tagsForEvent('ONAPPINSTALL')).toBe('all');
  });
});
