// Сторож сессии: приложение может часами висеть открытым во фрейме портала. Раз в несколько
// минут (и при возврате на вкладку) проверяем, что авторизация Битрикс24 жива и что не вышла
// новая версия приложения. Если нет — интерфейс блокируется окном «Обновите страницу»,
// чтобы сотрудник не работал с формой, которая уже не сохранится.
import { useSyncExternalStore } from 'react';
import type { SessionInfo } from '@btx24/shared';
import { apiGet } from './api.js';

/** denied — сотрудника убрали из списка доступа к приложению. */
export type SessionProblem = null | 'auth' | 'update' | 'denied';

const CHECK_EVERY_MS = 5 * 60_000;
/** Возврат на вкладку — проверяем, если с прошлой проверки прошло больше минуты. */
const MIN_GAP_MS = 60_000;

declare const __BUILD_ID__: string;
const BUILD_ID = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : '';

let problem: SessionProblem = null;
const listeners = new Set<() => void>();
let lastCheck = 0;
let started = false;

function set(p: Exclude<SessionProblem, null>) {
  // Потеря авторизации и доступа важнее обновления: их окна не заменяем.
  if (problem === 'auth' || problem === 'denied' || problem === p) return;
  problem = p;
  for (const l of listeners) l();
}

/** Сервер не принял токен даже после обновления, или портал не выдал новый. */
export function reportSessionLost(): void {
  set('auth');
}

export function useSessionProblem(): SessionProblem {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => problem,
  );
}

/** Одна проверка: авторизация (запрос сам обновит токен) и версия приложения. */
export async function checkSession(): Promise<void> {
  lastCheck = Date.now();
  try {
    const s = await apiGet<SessionInfo>('/session');
    if (!s.appAccess) set('denied');
  } catch {
    // 401 после обновления токена уже отмечен в api.ts; сеть/сервер — не повод блокировать.
  }
  if (!BUILD_ID) return;
  try {
    const res = await fetch('/version.json', { cache: 'no-store' });
    if (!res.ok) return;
    const v = (await res.json()) as { build?: string };
    if (v.build && v.build !== BUILD_ID) set('update');
  } catch {
    /* нет сети — проверим в следующий раз */
  }
}

export function startSessionWatch(): void {
  if (started) return;
  started = true;
  lastCheck = Date.now();
  setInterval(() => void checkSession(), CHECK_EVERY_MS);
  const onBack = () => {
    if (document.visibilityState === 'visible' && Date.now() - lastCheck > MIN_GAP_MS) void checkSession();
  };
  document.addEventListener('visibilitychange', onBack);
  window.addEventListener('focus', onBack);
}
