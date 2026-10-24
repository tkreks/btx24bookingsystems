import { describe, expect, it, vi } from 'vitest';
import { DashboardCache, DASHBOARD_CACHE_PREFIX, WithMeta, clearDashboardCaches, dashboardCacheAllowed, fromCacheOf, type SnapshotStorage } from './dashboard-cache.js';
class MemoryStorage implements SnapshotStorage {
  data = new Map<string,string>();
  get length() { return this.data.size; }
  key(i: number) { return [...this.data.keys()][i] ?? null; }
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string,v: string) { this.data.set(k,v); }
  removeItem(k: string) { this.data.delete(k); }
}
const path = '/dashboard/recent-calls?from=2026-10-24&to=2026-10-24';
const seed = async (storage: MemoryStorage, scope='portal:user:permissions', at=1000) => {
  const cache = new DashboardCache(scope, async () => ({ calls: 1 }), storage, () => at);
  cache.subscribe(path, () => undefined); await cache.refresh(path); return cache;
};
describe('dashboard snapshots and live queries', () => {
  it.each(['/calendar?date=2026-10-24', '/bookings', '/booking-alerts', '/resource-stops', '/dashboard?part=base', '/dashboard', '/dashboard/needs-close', '/openlines/chats/1/bookings', '/workday'])('never persists live booking/shift source %s', async p => {
    const storage = new MemoryStorage(); const fetch = vi.fn(async () => ({ n: 1 }));
    const cache = new DashboardCache('scope', fetch, storage);
    const release = cache.subscribe(p, () => undefined); await cache.refresh(p);
    expect(cache.snapshot(p).data).toEqual({ n: 1 }); expect(storage.length).toBe(0);
    release(); expect(cache.snapshot(p).data).toBeNull();
    cache.subscribe(p, () => undefined); await cache.refresh(p); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('restores immediately then revalidates, retaining data while pending', async () => {
    const storage = new MemoryStorage(); await seed(storage);
    let resolve!: (v: unknown) => void;
    const fetch = vi.fn(() => new Promise(r => { resolve = r; }));
    const cache = new DashboardCache('portal:user:permissions', fetch, storage, () => 2000);
    expect(cache.snapshot(path)).toMatchObject({ data: { calls: 1 }, cached: true });
    cache.subscribe(path, () => undefined); const flight = cache.refresh(path);
    expect(cache.snapshot(path)).toMatchObject({ data: { calls: 1 }, fetching: true });
    await Promise.resolve(); resolve({ calls: 2 }); await flight;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cache.snapshot(path)).toMatchObject({ data: { calls: 2 }, cached: false, fetching: false, updatedAt: 2000 });
  });
  it('isolates portal/user/permissions/period, expires after five minutes', async () => {
    const storage = new MemoryStorage(); await seed(storage);
    for (const scope of ['otherportal:user:permissions', 'portal:otheruser:permissions', 'portal:user:otherpermissions']) expect(new DashboardCache(scope, vi.fn(), storage).snapshot(path).data).toBeNull();
    const current = new DashboardCache('portal:user:permissions', vi.fn(), storage, () => 2000);
    expect(current.snapshot(path.replaceAll('24','23')).data).toBeNull();
    expect(new DashboardCache('portal:user:permissions', vi.fn(), storage, () => 302000).snapshot(path).data).toBeNull();
  });
  it('keeps last successful data on network errors and clears on forbidden/auth failures', async () => {
    const storage = new MemoryStorage(); await seed(storage);
    const fetch = vi.fn().mockRejectedValue(new Error('offline'));
    const cache = new DashboardCache('portal:user:permissions', fetch, storage, () => 2000);
    cache.subscribe(path, () => undefined); await cache.refresh(path);
    expect(cache.snapshot(path)).toMatchObject({ data: { calls: 1 }, error: 'offline' });
    for (const status of [403,401]) {
      fetch.mockRejectedValue(Object.assign(new Error('forbidden'), { status })); await cache.refresh(path);
      expect(cache.snapshot(path).data).toBeNull(); expect(storage.length).toBe(0);
    }
  });
  it('polls only observed resources when due; force refreshes on demand', async () => {
    let now = 1000; const fetch = vi.fn(async () => now);
    const cache = new DashboardCache('s', fetch, undefined, () => now);
    const off = cache.subscribe(path, () => undefined, undefined, 30000); await cache.refresh(path);
    now += 29999; cache.refreshActive(); expect(fetch).toHaveBeenCalledTimes(1);
    now++; cache.refreshActive(); await cache.refresh(path); expect(fetch).toHaveBeenCalledTimes(2);
    cache.refreshActive(true); await cache.refresh(path); expect(fetch).toHaveBeenCalledTimes(3);
    off(); now += 60000; cache.refreshActive(); expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('discards late writes after unmount, tolerates blocked storage, clears only dashboard data', async () => {
    const storage = new MemoryStorage(); let resolve!: (v: unknown) => void;
    const cache = new DashboardCache('s', () => new Promise(r => {resolve=r;}), storage);
    cache.subscribe(path, () => undefined); const flight = cache.refresh(path); await Promise.resolve(); cache.stop(); resolve({ secret: true }); await flight;
    expect(storage.length).toBe(0);
    await cache.refresh(path); expect(storage.length).toBe(0); // stopped store cannot start another request
    storage.setItem('auth-unrelated','preserve'); storage.setItem(DASHBOARD_CACHE_PREFIX+'old','remove'); clearDashboardCaches(storage);
    expect(storage.getItem('auth-unrelated')).toBe('preserve'); expect(storage.length).toBe(1);
    const blocked = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } } as unknown as SnapshotStorage;
    const live = new DashboardCache('s', async () => 42, blocked); live.subscribe(path, () => undefined); await live.refresh(path); expect(live.snapshot(path).data).toBe(42);
  });
  it('идентичные ответы сохраняют объект данных и не вызывают коррекцию прокрутки', async () => {
    let value = 1;
    const cache = new DashboardCache('s', async () => ({ items: [{id: value}] }));
    cache.subscribe(path, () => undefined); await cache.refresh(path);
    const data = cache.snapshot(path).data;
    const before = vi.fn(); cache.setBeforeDataChange(before);
    await cache.refresh(path); expect(cache.snapshot(path).data).toBe(data); expect(before).not.toHaveBeenCalled();
    value = 2; await cache.refresh(path); expect(before).toHaveBeenCalledTimes(1); expect(cache.snapshot(path).data).not.toBe(data);
  });
  it('allows only explicit dashboard snapshot endpoints', () => {
    expect(dashboardCacheAllowed('/dashboard?part=calls')).toBe(true);
    expect(dashboardCacheAllowed('/dashboard?part=deals')).toBe(true);
    expect(dashboardCacheAllowed('/dashboard/not-approved')).toBe(false);
  });
});

describe('серверный кэш (X-Cache)', () => {
  it('устаревший ответ сервера — «из кэша», переспрашиваем, пока сервер обновляет', async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const answers = [new WithMeta({ v: 1 }, { state: 'stale', ageMs: 120_000, refreshing: true }), new WithMeta({ v: 2 }, { state: 'miss', ageMs: 0, refreshing: false })];
      const cache = new DashboardCache('scope', async () => answers[n++], undefined, () => 1_000_000);
      cache.subscribe(path, () => undefined);
      await cache.refresh(path);
      const first = cache.snapshot(path);
      expect(first).toMatchObject({ data: { v: 1 }, source: 'cache', dataAt: 880_000, serverRefreshing: true });
      expect(fromCacheOf(first)).toBe(true);
      expect(cache.syncSnapshot()).toMatchObject({ fromCache: 1, active: 1, pending: 1 });
      await vi.advanceTimersByTimeAsync(3000);
      expect(cache.snapshot(path)).toMatchObject({ data: { v: 2 }, source: 'live', serverRefreshing: false });
      expect(fromCacheOf(cache.snapshot(path))).toBe(false);
      expect(cache.syncSnapshot()).toMatchObject({ fromCache: 0, pending: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
});
