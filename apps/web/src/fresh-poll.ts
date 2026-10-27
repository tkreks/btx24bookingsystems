/** Live views never restore snapshots. Skip hidden tabs and overlapping requests. */
export function freshPoll(load: () => Promise<unknown>, interval = 15_000): () => void {
  let stopped = false; let pending = false;
  const refresh = () => {
    if (stopped || pending || document.visibilityState === 'hidden') return;
    pending = true; void Promise.resolve().then(load).catch(() => undefined).finally(() => { pending = false; });
  };
  refresh();
  const timer = setInterval(refresh, interval);
  window.addEventListener('focus', refresh); window.addEventListener('online', refresh); window.addEventListener('btx24:mutation', refresh); document.addEventListener('visibilitychange', refresh);
  return () => { stopped = true; clearInterval(timer); window.removeEventListener('focus', refresh); window.removeEventListener('online', refresh); window.removeEventListener('btx24:mutation', refresh); document.removeEventListener('visibilitychange', refresh); };
}

/**
 * Опрос раз в `interval` без первого запроса (его делает экран сам): пропускает скрытую вкладку и тик,
 * пока не ответил предыдущий — иначе при медленном портале запросы копятся в очереди лимита REST.
 */
export function pollEvery(load: () => Promise<unknown> | void, interval = 15_000): () => void {
  let pending = false;
  const timer = setInterval(() => {
    if (pending || document.visibilityState === 'hidden') return;
    pending = true;
    void Promise.resolve().then(load).catch(() => undefined).finally(() => { pending = false; });
  }, interval);
  return () => clearInterval(timer);
}
