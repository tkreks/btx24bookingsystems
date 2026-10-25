import { AsyncLocalStorage } from 'node:async_hooks';
import type { Response } from 'express';
import type { CacheTag } from './swr-cache.js';

/**
 * Ответ текущего запроса — чтобы кэш дашборда сообщил клиенту, откуда данные (заголовки `X-Cache*`);
 * `rest` — REST-вызовы Битрикс24 запроса и ожидание в очереди лимита (для журнала медленных запросов).
 */
export const requestContext = new AsyncLocalStorage<{ res: Response; rest?: RestStats }>();

export interface RestStats {
  calls: number;
  waitMs: number;
  methods: Map<string, number>;
}

/** Все REST-вызовы процесса за текущую минуту (и вне запросов: фоновые задачи, обновление кэша). */
const minute: RestStats & { maxWaitMs: number; background: number } = { calls: 0, waitMs: 0, maxWaitMs: 0, background: 0, methods: new Map() };
let minuteSink: ((line: string) => void) | null = null;

/** Раз в минуту — строка в журнал, если REST-вызовов было много или ждали очереди (лимит портала). */
export function startRestMinuteLog(sink: (line: string) => void): void {
  if (minuteSink) return;
  minuteSink = sink;
  setInterval(() => {
    if (minute.calls >= 60 || minute.maxWaitMs >= 3000) {
      const top = [...minute.methods].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([m, n]) => `${m}×${n}`).join(' ');
      sink(`rest/min=${minute.calls} background=${minute.background} wait max=${minute.maxWaitMs}ms avg=${Math.round(minute.waitMs / Math.max(1, minute.calls))}ms ${top}`);
    }
    Object.assign(minute, { calls: 0, waitMs: 0, maxWaitMs: 0, background: 0 });
    minute.methods.clear();
  }, 60_000).unref();
}

/** Учесть REST-вызов: в текущем запросе (журнал медленных) и в поминутной сводке процесса. */
export function countRest(method: string, waitMs: number): void {
  minute.calls++;
  minute.waitMs += waitMs;
  minute.maxWaitMs = Math.max(minute.maxWaitMs, waitMs);
  minute.methods.set(method, (minute.methods.get(method) ?? 0) + 1);
  const s = requestContext.getStore()?.rest;
  if (!s) {
    minute.background++;
    return;
  }
  s.calls++;
  s.waitMs += waitMs;
  s.methods.set(method, (s.methods.get(method) ?? 0) + 1);
}

/** «rest=12 wait=4300ms crm.deal.list×5 batch×3» — для журнала медленных запросов. */
export function restSummary(s: RestStats | undefined): string {
  if (!s?.calls) return '';
  const top = [...s.methods].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([m, n]) => `${m}×${n}`).join(' ');
  return ` rest=${s.calls} wait=${s.waitMs}ms ${top}`;
}

/**
 * Какие разделы кэша дашборда меняет успешный запрос (путь без `/api`). null — ничего (вход, отметки
 * активности, шаблоны, раскладка); `'all'` — всё (права, настройки и всё, что здесь не описано).
 */
export function tagsForRequest(method: string, path: string): readonly CacheTag[] | 'all' | null {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;
  const p = path.replace(/^\/api/, '');
  const starts = (...prefixes: string[]) => prefixes.some((x) => p === x || p.startsWith(`${x}/`));
  // Частые служебные запросы — без сброса.
  if (starts('/activity', '/auth', '/dashboard/layout', '/openlines/templates', '/openlines/files', '/resource-stops/check', '/admin/messengers', '/messengers')) return null;
  if (starts('/bookings', '/resource-stops', '/booking-alerts')) return ['bookings', 'deals', 'activity'];
  if (starts('/deals', '/payments', '/certificates')) return ['deals', 'bookings', 'activity'];
  if (starts('/openlines', '/dashboard/hidden-chats')) return ['chats', 'activity'];
  if (starts('/workday')) return ['activity'];
  return 'all';
}

/** Какие разделы меняет событие Битрикс24 (`event` из тела запроса на `/api/b24/events`). */
export function tagsForEvent(event: unknown): readonly CacheTag[] | 'all' {
  const e = String(event ?? '').toUpperCase();
  if (e.startsWith('ONBOOKING')) return ['bookings', 'deals'];
  // Стадия сделки меняет «Сделки к закрытию» и цвета броней.
  if (e.startsWith('ONCRMDEAL')) return ['deals', 'bookings'];
  if (e.startsWith('ONVOXIMPLANT')) return ['calls', 'activity'];
  return 'all';
}
