import { captureDashboardScroll } from './scroll-anchor.js';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { MyGroupDto, SessionInfo } from '@btx24/shared';
import { apiGetMeta } from '../api.js';
import { DashboardCache, WithMeta, type DashboardSnapshot } from './dashboard-cache.js';

const Context = createContext<DashboardCache | null>(null);
const EMPTY: DashboardSnapshot<never> = { data: null, error: '', fetching: false, updatedAt: null, cached: false, dataAt: null, source: null, serverRefreshing: false };
/** Ответ с отметкой серверного кэша (X-Cache) — хранилище покажет, откуда данные. */
const transport = (path: string) => apiGetMeta(path).then((r) => new WithMeta(r.data, r.meta));
/** Блок дашборда собирает пути своих запросов — для точки свежести данных. */
const BlockPaths = createContext<((path: string) => () => void) | null>(null);
export function dashboardScope(session: SessionInfo, groups: MyGroupDto[] | null): string {
  return JSON.stringify([session.portal.domain, session.user.id, session.canManageApp, session.appAccess, (groups ?? []).map(g => [g.id, g.role, [...g.permissions].sort(), [...g.resourceIds].sort((a,b)=>a-b)])]);
}
export function DashboardSyncProvider({ scope, children }: { scope: string; children: ReactNode }) {
  const store = useMemo(() => { let storage: Storage | undefined; try { storage = sessionStorage; } catch { /* iframe */ } return new DashboardCache(scope, transport, storage); }, [scope]);
  const pendingScroll = useRef<(() => void) | null>(null);
  const sync = useSyncExternalStore(store.subscribeSync, store.syncSnapshot);
  useLayoutEffect(() => {
    const restore = pendingScroll.current; pendingScroll.current = null; restore?.();
  }, [sync]);
  useEffect(() => {
    store.setBeforeDataChange(() => { pendingScroll.current ??= captureDashboardScroll(); });
    store.start();
    const tick = () => { if (document.visibilityState !== 'hidden') store.refreshActive(); };
    const focus = () => { if (document.visibilityState !== 'hidden') store.refreshActive(true); };
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const changed = () => { clearTimeout(debounce); debounce = setTimeout(() => store.refreshActive(true), 200); };
    const lost = () => store.stop();
    window.addEventListener('btx24:session-lost', lost);
    const timer = setInterval(tick, 1000);
    document.addEventListener('visibilitychange', focus); window.addEventListener('focus', focus); window.addEventListener('online', focus); window.addEventListener('btx24:mutation', changed);
    return () => { store.setBeforeDataChange(); pendingScroll.current = null; window.removeEventListener('btx24:session-lost', lost); store.stop(); clearInterval(timer); clearTimeout(debounce); document.removeEventListener('visibilitychange', focus); window.removeEventListener('focus', focus); window.removeEventListener('online', focus); window.removeEventListener('btx24:mutation', changed); };
  }, [store]);
  return <Context.Provider key={scope} value={store}>{children}</Context.Provider>;
}
export function useDashboardQuery<T>(path: string | null, loader?: () => Promise<T>, interval = 30_000) {
  const store = useContext(Context);
  if (!store) throw new Error('Dashboard query requires DashboardSyncProvider');
  const subscribe = useCallback((listener: () => void) => path ? store.subscribe(path, listener, loader, interval) : () => undefined, [store, path, loader, interval]);
  const snapshot = useCallback(() => path ? store.snapshot<T>(path) : EMPTY, [store, path]);
  const result = useSyncExternalStore(subscribe, snapshot);
  const register = useContext(BlockPaths);
  useEffect(() => (path && register ? register(path) : undefined), [register, path]);
  const refresh = useCallback(() => path ? store.refresh(path) : Promise.resolve(), [store, path]);
  return { ...result, refresh };
}
/** Обновить все блоки дашборда (после действия, меняющего несколько показателей). */
export function useDashboardRefreshAll() {
  const store = useContext(Context);
  return useCallback(() => store?.refreshActive(true), [store]);
}
export function DashboardSyncStatus() {
  const store = useContext(Context); if (!store) throw new Error('Missing dashboard sync');
  const state = useSyncExternalStore(store.subscribeSync, store.syncSnapshot);
  const cacheText = state.fromCache ? `из кэша: ${state.fromCache} из ${state.active}` : '';
  const label = state.pending
    ? cacheText ? `Данные ${cacheText} · обновляем из Битрикс24…` : `Синхронизация с Битрикс24… загружено ${Math.max(0, state.active - state.pending)} из ${state.active}`
    : state.errors ? 'Не всё удалось обновить · повторим автоматически'
    : cacheText ? `Данные ${cacheText}` : state.updatedAt ? 'Данные обновлены' : 'Загрузка данных…';
  return <div className={`dashboard-sync-status${state.errors ? ' has-error' : ''}`} role="status" aria-live="polite"><span className={state.pending ? 'sync-dot active' : 'sync-dot'} aria-hidden="true" /><span className="sync-label" title={label}>{label}</span><time dateTime={state.updatedAt ? new Date(state.updatedAt).toISOString() : undefined}>{state.updatedAt ? new Date(state.updatedAt).toLocaleTimeString('ru-RU', {hour:'2-digit',minute:'2-digit'}) : '—'}</time><button type="button" className="link" disabled={!!state.pending} onClick={() => store.refreshActive(true)} aria-label="Обновить данные дашборда">↻</button></div>;
}

/**
 * Обёртка блока: запросы внутри неё (и переданные `paths` — запросы страницы, из которых блок взял
 * данные) дают точку-индикатор внизу блока: зелёная — свежие, синяя — обновляем,
 * оранжевая — данным больше минуты, красная — больше 10 минут.
 */
export function BlockSync({ paths = [], children }: { paths?: string[]; children: ReactNode }) {
  const [own, setOwn] = useState<string[]>([]);
  const register = useCallback((path: string) => {
    setOwn((p) => (p.includes(path) ? p : [...p, path]));
    return () => setOwn((p) => p.filter((x) => x !== path));
  }, []);
  const all = [...new Set([...paths, ...own])];
  return (
    <BlockPaths.Provider value={register}>
      {children}
      <BlockSyncNote paths={all} />
    </BlockPaths.Provider>
  );
}

const STALE_MS = 60_000;
const OLD_MS = 10 * 60_000;
const DOT_TITLE: Record<string, string> = { live: 'Данные актуальны', sync: 'Обновляем из Битрикс24…', stale: 'Данным больше минуты', old: 'Данным больше 10 минут' };

function BlockSyncNote({ paths }: { paths: string[] }) {
  const store = useContext(Context);
  const key = paths.join('\n');
  const read = useCallback(() => {
    const snaps = store ? key.split('\n').filter(Boolean).flatMap((p) => store.peek(p) ?? []) : [];
    if (!snaps.length || snaps.some((s) => s.data === null)) return '';
    if (snaps.some((s) => s.fetching || s.serverRefreshing)) return 'sync';
    const dates = snaps.flatMap((s) => (s.dataAt === null ? [] : [s.dataAt]));
    const age = dates.length ? Date.now() - Math.min(...dates) : 0;
    return age > OLD_MS ? 'old' : age > STALE_MS ? 'stale' : 'live';
  }, [store, key]);
  // Возраст данных растёт и без событий хранилища — перечитываем раз в 15 с.
  const subscribe = useCallback((listener: () => void) => {
    const off = (store?.subscribeSync ?? noopSubscribe)(listener);
    const timer = window.setInterval(listener, 15_000);
    return () => { window.clearInterval(timer); off(); };
  }, [store]);
  const kind = useSyncExternalStore(subscribe, read);
  return (
    <p className={`dash-cell-sync${kind ? ` ${kind}` : ''}`} role="status" aria-live="off">
      {kind && <span className="sync-dot" title={DOT_TITLE[kind]} aria-label={DOT_TITLE[kind]} />}
    </p>
  );
}
const noopSubscribe = () => () => undefined;
