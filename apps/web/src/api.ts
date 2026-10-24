import { clearDashboardCaches } from './dashboard/dashboard-cache.js';
import type { ApiError } from '@btx24/shared';
import { getAuth, isStandalone, placementContext, refreshAuth, type B24Auth } from './b24.js';
import { reportSessionLost } from './session-guard.js';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Запрос к нашему API с токеном пользователя Битрикс24. Токен обновляется заранее (b24.ts);
 * сервер всё равно ответил «токен истёк/недействителен» — один раз берём новый у портала и
 * повторяем. Не вышло — сессия потеряна: интерфейс блокируется с просьбой обновить страницу.
 */
export async function apiGet<T>(path: string): Promise<T> {
  return request<T>('GET', path);
}

/** Откуда сервер взял ответ блока дашборда (заголовки `X-Cache*`, ADR 0012). */
export interface ServerCacheMeta {
  state: 'fresh' | 'stale' | 'miss';
  /** Возраст данных на момент ответа, мс. */
  ageMs: number;
  /** Сервер обновляет данные в фоне — свежий ответ будет через несколько секунд. */
  refreshing: boolean;
}

export function cacheMetaOf(h: Pick<Headers, 'get'>): ServerCacheMeta | null {
  const state = h.get('X-Cache');
  if (state !== 'fresh' && state !== 'stale' && state !== 'miss') return null;
  return { state, ageMs: Math.max(0, Number(h.get('X-Cache-Age')) || 0) * 1000, refreshing: h.get('X-Cache-Refreshing') === '1' };
}

/** GET вместе с отметкой серверного кэша (для дашборда). */
export async function apiGetMeta<T>(path: string): Promise<{ data: T; meta: ServerCacheMeta | null }> {
  let meta: ServerCacheMeta | null = null;
  const data = await request<T>('GET', path, undefined, false, (h) => (meta = cacheMetaOf(h)));
  return { data, meta };
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('POST', path, body);
}

async function request<T>(method: string, path: string, body?: unknown, retried = false, onHeaders?: (h: Headers) => void): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    cache: 'no-store',
    headers: {
      ...(await authHeaders(retried)),
      // Откуда открыто приложение (сделка, меню) — для журнала действий.
      'X-Btx24-Placement': isStandalone() ? 'STANDALONE' : placementContext().placement,
      // FormData: Content-Type с границей частей выставит браузер.
      ...(body === undefined || body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  if (res.ok) {
    onHeaders?.(res.headers);
    const data = res.status === 204 ? (undefined as T) : ((await res.json()) as T);
    if (method !== 'GET') window.dispatchEvent(new Event('btx24:mutation'));
    return data;
  }
  const err = (await res.json().catch(() => ({}))) as Partial<ApiError>;
  if (res.status === 401 && isStandalone()) reportSessionLost();
  else if (res.status === 401 && (err.code === 'TOKEN_EXPIRED' || err.code === 'INVALID_TOKEN')) {
    if (!retried) return request<T>(method, path, body, true, onHeaders);
    reportSessionLost();
  }
  throw new ApiRequestError(res.status, err.code ?? 'HTTP_ERROR', err.message ?? `Ошибка ${res.status}`);
}

/**
 * Авторизация запроса: во фрейме — токен сотрудника от портала; вне портала — cookie сессии
 * (браузер отправит сам) и заголовок, без которого сервер cookie не примет (защита от CSRF).
 */
async function authHeaders(retried: boolean): Promise<Record<string, string>> {
  if (isStandalone()) return { 'X-Btx24-Standalone': '1' };
  let auth: B24Auth | null;
  try {
    auth = retried ? await refreshAuth() : await getAuth();
  } catch (e) {
    reportSessionLost();
    throw new ApiRequestError(401, 'SESSION_LOST', e instanceof Error ? e.message : 'Авторизация Битрикс24 потеряна');
  }
  if (!auth) throw new ApiRequestError(401, 'UNAUTHORIZED', 'Откройте приложение из Битрикс24');
  return { Authorization: `Bearer ${auth.token}`, 'X-B24-Member-Id': auth.memberId };
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  return request<T>('PUT', path, body);
}

export async function apiDelete<T = void>(path: string): Promise<T> {
  return request<T>('DELETE', path);
}

/** Файл с нашего API (картинки чата и т. п.): `<img src>` не умеет передать токен — берём Blob. */
export async function apiBlob(path: string, retried = false): Promise<Blob> {
  const res = await fetch(`/api${path}`, { headers: await authHeaders(retried) });
  if (res.ok) return res.blob();
  const err = (await res.json().catch(() => ({}))) as Partial<ApiError>;
  if (res.status === 401 && !isStandalone() && (err.code === 'TOKEN_EXPIRED' || err.code === 'INVALID_TOKEN') && !retried) return apiBlob(path, true);
  throw new ApiRequestError(res.status, err.code ?? 'HTTP_ERROR', err.message ?? `Ошибка ${res.status}`);
}

/** Загрузка файла (multipart, поле `file`). */
export async function apiUpload<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append('file', file, file.name);
  return request<T>('POST', path, form);
}

/** Multipart с дополнительными полями (адресат, подпись файла). */
export async function apiPostForm<T>(path: string, form: FormData): Promise<T> {
  return request<T>('POST', path, form);
}

/** Выход из приложения, открытого вне портала: сессия удаляется на сервере, затем страница входа. */
export async function logout(): Promise<void> {
  clearDashboardCaches(); window.dispatchEvent(new Event('btx24:session-lost'));
  await fetch('/api/auth/logout', { method: 'POST', headers: { 'X-Btx24-Standalone': '1' } }).catch(() => undefined);
  window.location.assign('/');
}
