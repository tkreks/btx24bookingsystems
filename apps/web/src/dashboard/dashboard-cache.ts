export const DASHBOARD_CACHE_PREFIX = 'btx24.dashboard.snapshot.v1:';
const MAX_AGE = 5 * 60_000;
/**
 * Откуда данные блока: `snapshot` — снимок вкладки (sessionStorage), `cache` — серверный кэш
 * (ADR 0012), `live` — посчитаны сервером только что. `dataAt` — на какой момент данные.
 */
export type DataSource = 'snapshot' | 'cache' | 'live';
export interface DashboardSnapshot<T = unknown> { data: T | null; error: string; fetching: boolean; updatedAt: number | null; cached: boolean; dataAt: number | null; source: DataSource | null; serverRefreshing: boolean }
export interface SyncSnapshot { pending: number; errors: number; cached: boolean; updatedAt: number | null; fromCache: number; active: number }
/** Ответ транспорта с отметкой серверного кэша. */
export class WithMeta { constructor(readonly data: unknown, readonly meta: { state: 'fresh' | 'stale' | 'miss'; ageMs: number; refreshing: boolean } | null) {} }
/** Сервер обновляет данные в фоне — переспрашиваем через столько, не больше REVALIDATE_TRIES раз подряд. */
const REVALIDATE_MS = 3000;
const REVALIDATE_TRIES = 5;
/** Данные старше — блок помечен «из кэша». */
export const CACHE_NOTE_MS = 60_000;
type Entry = { path: string; snapshot: DashboardSnapshot; listeners: Set<() => void>; loader: () => Promise<unknown>; flight: Promise<void> | null; attemptedAt: number; cache: boolean; interval: number; revalidations: number; revalidate: ReturnType<typeof setTimeout> | null };
/** Блок показывает данные из кэша: снимок вкладки или ответ сервера, которому на момент ответа уже была минута. */
export function fromCacheOf(s: DashboardSnapshot): boolean {
  return s.data !== null && (s.source === 'snapshot' || (s.source === 'cache' && s.dataAt !== null && s.updatedAt !== null && s.updatedAt - s.dataAt >= CACHE_NOTE_MS));
}
const EMPTY_SNAPSHOT: DashboardSnapshot = { data: null, error: '', fetching: false, updatedAt: null, cached: false, dataAt: null, source: null, serverRefreshing: false };
export type SnapshotStorage = Pick<Storage, 'getItem'|'setItem'|'removeItem'|'key'|'length'>;

/** Календарь, списки броней, доступность, стопы и текущая очередь закрытия никогда не сохраняются. */
export function dashboardCacheAllowed(path: string): boolean {
  const url = new URL(path, 'https://local.invalid');
  if (url.pathname === '/dashboard') return ['calls', 'deals'].includes(url.searchParams.get('part') ?? '');
  return ['/head-dashboard', '/dashboard/recent-calls', '/dashboard/activity', '/dashboard/my-activity', '/dashboard/chat-attention', '/dashboard/deal-gaps', '/admin/action-log', '/certificates'].includes(url.pathname);
}
export function clearDashboardCaches(storage?: SnapshotStorage): void {
  try {
    const target = storage ?? (typeof sessionStorage === 'undefined' ? undefined : sessionStorage);
    if (!target) return;
    for (let i = target.length - 1; i >= 0; i--) { const key = target.key(i); if (key?.startsWith(DASHBOARD_CACHE_PREFIX)) target.removeItem(key); }
  } catch { /* storage может быть запрещён в iframe */ }
}

/** Снимки не содержат токенов; пространство ключей задаёт проверенная сессия/права. */
export class DashboardCache {
  private readonly entries = new Map<string, Entry>();
  private readonly syncListeners = new Set<() => void>();
  private sync: SyncSnapshot = { pending: 0, errors: 0, cached: false, updatedAt: null, fromCache: 0, active: 0 };
  private disposed = false;
  private beforeDataChange?: () => void;
  setBeforeDataChange(listener?: () => void) { this.beforeDataChange = listener; }
  constructor(private readonly scope: string, private readonly transport: (path: string) => Promise<unknown>, private readonly storage?: SnapshotStorage, private readonly now = () => Date.now()) {}
  private storageKey(path: string) { return `${DASHBOARD_CACHE_PREFIX}${encodeURIComponent(this.scope)}:${encodeURIComponent(path)}`; }
  private entry(path: string): Entry {
    let e = this.entries.get(path); if (e) return e;
    const cache = dashboardCacheAllowed(path);
    let snapshot: DashboardSnapshot = EMPTY_SNAPSHOT;
    if (cache && this.storage) try {
      const raw = this.storage.getItem(this.storageKey(path));
      if (raw) {
        const saved = JSON.parse(raw) as { scope: string; at: number; dataAt?: number; data: unknown };
        if (saved.scope === this.scope && Number.isFinite(saved.at) && this.now() - saved.at <= MAX_AGE && this.now() >= saved.at) snapshot = { ...snapshot, data: saved.data, updatedAt: saved.at, cached: true, dataAt: saved.dataAt ?? saved.at, source: 'snapshot' };
        else this.storage.removeItem(this.storageKey(path));
      }
    } catch { /* испорченный/запрещённый storage не мешает живому запросу */ }
    e = { path, snapshot, listeners: new Set(), loader: () => this.transport(path), flight: null, attemptedAt: 0, cache, interval: 30_000, revalidations: 0, revalidate: null };
    this.entries.set(path, e); return e;
  }
  snapshot<T>(path: string): DashboardSnapshot<T> { return this.entry(path).snapshot as DashboardSnapshot<T>; }
  /** Снимок без создания записи — для подписи блока (путь мог ещё не подписаться). */
  peek(path: string): DashboardSnapshot | null { return this.entries.get(path)?.snapshot ?? null; }
  subscribe(path: string, listener: () => void, loader?: () => Promise<unknown>, interval = 30_000): () => void {
    const e = this.entry(path); if (loader) e.loader = loader; e.interval = interval;
    e.listeners.add(listener); this.emit(); void this.refresh(path);
    return () => { e.listeners.delete(listener); if (!e.listeners.size && !e.cache) e.snapshot = EMPTY_SNAPSHOT; this.emit(); };
  }
  subscribeSync = (listener: () => void) => { this.syncListeners.add(listener); return () => this.syncListeners.delete(listener); };
  syncSnapshot = () => this.sync;
  private emit(e?: Entry) {
    e?.listeners.forEach(l => l());
    const active = [...this.entries.values()].filter(v => v.listeners.size);
    const dates = active.flatMap(v => v.snapshot.updatedAt === null ? [] : [v.snapshot.updatedAt]);
    const fromCache = active.filter(v => fromCacheOf(v.snapshot)).length;
    this.sync = { pending: active.filter(v => v.snapshot.fetching || v.snapshot.serverRefreshing).length, errors: active.filter(v => v.snapshot.error).length, cached: active.some(v => v.snapshot.cached), updatedAt: dates.length ? Math.min(...dates) : null, fromCache, active: active.length };
    this.syncListeners.forEach(l => l());
  }
  refresh(path: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const e = this.entry(path); if (e.flight) return e.flight;
    e.attemptedAt = this.now(); e.snapshot = { ...e.snapshot, fetching: true }; this.emit(e);
    if (e.revalidate) { clearTimeout(e.revalidate); e.revalidate = null; }
    e.flight = Promise.resolve().then(e.loader).then(result => {
      if (this.disposed || (!e.cache && !e.listeners.size)) return;
      const { data, meta } = result instanceof WithMeta ? result : { data: result, meta: null };
      const unchanged = JSON.stringify(e.snapshot.data) === JSON.stringify(data);
      if (!unchanged) this.beforeDataChange?.();
      const now = this.now();
      const serverRefreshing = !!meta?.refreshing && e.revalidations < REVALIDATE_TRIES;
      e.snapshot = { data: unchanged ? e.snapshot.data : data, error: '', fetching: true, updatedAt: now, cached: false, dataAt: now - (meta?.ageMs ?? 0), source: meta && meta.state !== 'miss' ? 'cache' : 'live', serverRefreshing };
      // Сервер отдал кэш и обновляет его в фоне — свежие данные заберём, не дожидаясь опроса.
      e.revalidations = serverRefreshing ? e.revalidations + 1 : 0;
      if (serverRefreshing) e.revalidate = setTimeout(() => { e.revalidate = null; if (e.listeners.size) void this.refresh(path); }, REVALIDATE_MS);
      if (e.cache && this.storage) try { this.storage.setItem(this.storageKey(path), JSON.stringify({ scope: this.scope, at: e.snapshot.updatedAt, dataAt: e.snapshot.dataAt, data })); } catch { /* quota/private iframe */ }
    }, (error: unknown) => {
      if (this.disposed) return;
      const message = error instanceof Error ? error.message : 'Не удалось обновить данные';
      if (message !== e.snapshot.error) this.beforeDataChange?.();
      const status = (error as { status?: number } | null)?.status;
      if (status === 401 || status === 403) { e.snapshot = { ...e.snapshot, data: null, updatedAt: null, cached: false, dataAt: null, source: null }; try { this.storage?.removeItem(this.storageKey(path)); } catch { /* storage */ } }
      e.snapshot = { ...e.snapshot, error: message, serverRefreshing: false };
    }).finally(() => { e.flight = null; e.snapshot = { ...e.snapshot, fetching: false }; if (!this.disposed) this.emit(e); });
    return e.flight;
  }
  refreshActive(force = false): void { for (const e of this.entries.values()) if (e.listeners.size && (force || this.now() - e.attemptedAt >= e.interval)) void this.refresh(e.path); }
  start() {
    this.disposed = false;
    try { if (this.storage) for (let i = this.storage.length - 1; i >= 0; i--) {
      const key = this.storage.key(i); if (!key?.startsWith(DASHBOARD_CACHE_PREFIX)) continue;
      const saved = JSON.parse(this.storage.getItem(key) ?? 'null') as { scope?: string; at?: number } | null;
      if (saved?.scope !== this.scope || !saved.at || this.now() - saved.at > MAX_AGE) this.storage.removeItem(key);
    } } catch { /* storage */ }
  }
  stop() { this.disposed = true; for (const e of this.entries.values()) if (e.revalidate) { clearTimeout(e.revalidate); e.revalidate = null; } }
}
