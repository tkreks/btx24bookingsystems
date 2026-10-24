import { captureDashboardScroll } from './scroll-anchor.js';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { MyGroupDto, SessionInfo } from '@btx24/shared';
import { apiGetMeta } from '../api.js';
import { DashboardCache, fromCacheOf, WithMeta, type DashboardSnapshot } from './dashboard-cache.js';

const Context = createContext<DashboardCache | null>(null);
const EMPTY: DashboardSnapshot<never> = { data: null, error: '', fetching: false, updatedAt: null, cached: false, dataAt: null, source: null, serverRefreshing: false };
/** Ответ с отметкой серверного кэша (X-Cache) — хранилище покажет, откуда данные. */
const transport = (path: string) => apiGetMeta(path).then((r) => new WithMeta(r.data, r.meta));
/** Блок дашборда собирает пути своих запросов — для подписи «из кэша / обновлено». */
const BlockPaths = createContext<((path: string) => () => void) | null>(null);
const hhmm = (at: number) => new Date(at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
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
    ? cacheText ? `Данные ${cacheText} · обновляем из Битрикс24…` : 'Синхронизация с Битрикс24…'
    : state.errors ? 'Не всё удалось обновить · повторим автоматически'
    : cacheText ? `Данные ${cacheText}` : state.updatedAt ? 'Данные обновлены' : 'Загрузка данных…';
  return <div className={`dashboard-sync-status${state.errors ? ' has-error' : ''}`} role="status" aria-live="polite"><span className={state.pending ? 'sync-dot active' : 'sync-dot'} aria-hidden="true" /><span className="sync-label" title={label}>{label}</span><time dateTime={state.updatedAt ? new Date(state.updatedAt).toISOString() : undefined}>{state.updatedAt ? new Date(state.updatedAt).toLocaleTimeString('ru-RU', {hour:'2-digit',minute:'2-digit'}) : '—'}</time><button type="button" className="link" disabled={!!state.pending} onClick={() => store.refreshActive(true)} aria-label="Обновить данные дашборда">↻</button></div>;
}

/**
 * Обёртка блока: запросы внутри неё (и переданные `paths` — запросы страницы, из которых блок взял
 * данные) дают подпись внизу блока — «из кэша · данные на 14:02 · обновляем…» или «обновлено 14:05».
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

function BlockSyncNote({ paths }: { paths: string[] }) {
  const store = useContext(Context);
  const key = paths.join('\n');
  const read = useCallback(() => {
    const snaps = store ? key.split('\n').filter(Boolean).flatMap((p) => store.peek(p) ?? []) : [];
    if (!snaps.length || snaps.some((s) => s.data === null)) return '';
    const refreshing = snaps.some((s) => s.fetching || s.serverRefreshing);
    const dates = snaps.flatMap((s) => (s.dataAt === null ? [] : [s.dataAt]));
    const at = dates.length ? Math.min(...dates) : null;
    if (snaps.some((s) => s.error)) return `error|не удалось обновить${at ? ` · данные на ${hhmm(at)}` : ''}`;
    if (snaps.some(fromCacheOf)) return `cache|из кэша${at ? ` · данные на ${hhmm(at)}` : ''}${refreshing ? ' · обновляем…' : ''}`;
    return refreshing ? 'sync|обновляем…' : `live|обновлено${at ? ` ${hhmm(at)}` : ''}`;
  }, [store, key]);
  const note = useSyncExternalStore(store?.subscribeSync ?? noopSubscribe, read);
  const [kind, text] = note ? note.split('|') : ['', ''];
  return (
    <p className={`dash-cell-sync${kind ? ` ${kind}` : ''}`} role="status" aria-live="off">
      {kind && <span className="sync-dot" aria-hidden="true" />}
      {text}
    </p>
  );
}
const noopSubscribe = () => () => undefined;
