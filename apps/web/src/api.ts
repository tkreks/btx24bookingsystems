import type { ApiError } from '@btx24/shared';
import { currentAuth, refreshAuth } from './b24.js';

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
 * Запрос к нашему API с токеном пользователя Битрикс24. Истёк токен (401 TOKEN_EXPIRED) —
 * один раз берём новый у портала и повторяем.
 */
export async function apiGet<T>(path: string): Promise<T> {
  return request<T>('GET', path);
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('POST', path, body);
}

async function request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
  const auth = retried ? await refreshAuth() : currentAuth();
  if (!auth) throw new ApiRequestError(401, 'UNAUTHORIZED', 'Откройте приложение из Битрикс24');
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${auth.token}`,
      'X-B24-Member-Id': auth.memberId,
      // FormData: Content-Type с границей частей выставит браузер.
      ...(body === undefined || body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  if (res.ok) return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  const err = (await res.json().catch(() => ({}))) as Partial<ApiError>;
  if (res.status === 401 && err.code === 'TOKEN_EXPIRED' && !retried) return request<T>(method, path, body, true);
  throw new ApiRequestError(res.status, err.code ?? 'HTTP_ERROR', err.message ?? `Ошибка ${res.status}`);
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  return request<T>('PUT', path, body);
}

export async function apiDelete(path: string): Promise<void> {
  return request<void>('DELETE', path);
}

/** Загрузка файла (multipart, поле `file`). */
export async function apiUpload<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append('file', file, file.name);
  return request<T>('POST', path, form);
}
