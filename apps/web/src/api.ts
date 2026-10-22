import type { ApiError } from '@btx24/shared';
import { getAuth, placementContext, refreshAuth, type B24Auth } from './b24.js';
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

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('POST', path, body);
}

async function request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
  let auth: B24Auth | null;
  try {
    auth = retried ? await refreshAuth() : await getAuth();
  } catch (e) {
    reportSessionLost();
    throw new ApiRequestError(401, 'SESSION_LOST', e instanceof Error ? e.message : 'Авторизация Битрикс24 потеряна');
  }
  if (!auth) throw new ApiRequestError(401, 'UNAUTHORIZED', 'Откройте приложение из Битрикс24');
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${auth.token}`,
      'X-B24-Member-Id': auth.memberId,
      // Откуда открыто приложение (сделка, меню) — для журнала действий.
      'X-Btx24-Placement': placementContext().placement,
      // FormData: Content-Type с границей частей выставит браузер.
      ...(body === undefined || body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  if (res.ok) return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  const err = (await res.json().catch(() => ({}))) as Partial<ApiError>;
  if (res.status === 401 && (err.code === 'TOKEN_EXPIRED' || err.code === 'INVALID_TOKEN')) {
    if (!retried) return request<T>(method, path, body, true);
    reportSessionLost();
  }
  throw new ApiRequestError(res.status, err.code ?? 'HTTP_ERROR', err.message ?? `Ошибка ${res.status}`);
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  return request<T>('PUT', path, body);
}

export async function apiDelete(path: string): Promise<void> {
  return request<void>('DELETE', path);
}

/** Файл с нашего API (картинки чата и т. п.): `<img src>` не умеет передать токен — берём Blob. */
export async function apiBlob(path: string, retried = false): Promise<Blob> {
  let auth: B24Auth | null;
  try {
    auth = retried ? await refreshAuth() : await getAuth();
  } catch (e) {
    reportSessionLost();
    throw new ApiRequestError(401, 'SESSION_LOST', e instanceof Error ? e.message : 'Авторизация Битрикс24 потеряна');
  }
  if (!auth) throw new ApiRequestError(401, 'UNAUTHORIZED', 'Откройте приложение из Битрикс24');
  const res = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${auth.token}`, 'X-B24-Member-Id': auth.memberId } });
  if (res.ok) return res.blob();
  const err = (await res.json().catch(() => ({}))) as Partial<ApiError>;
  if (res.status === 401 && (err.code === 'TOKEN_EXPIRED' || err.code === 'INVALID_TOKEN') && !retried) return apiBlob(path, true);
  throw new ApiRequestError(res.status, err.code ?? 'HTTP_ERROR', err.message ?? `Ошибка ${res.status}`);
}

/** Загрузка файла (multipart, поле `file`). */
export async function apiUpload<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append('file', file, file.name);
  return request<T>('POST', path, form);
}
