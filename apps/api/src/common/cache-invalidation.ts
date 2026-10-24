import { AsyncLocalStorage } from 'node:async_hooks';
import type { Response } from 'express';
import type { CacheTag } from './swr-cache.js';

/** Ответ текущего запроса — чтобы кэш дашборда сообщил клиенту, откуда данные (заголовки `X-Cache*`). */
export const requestContext = new AsyncLocalStorage<{ res: Response }>();

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
