// Тонкая обёртка над BX24 JS SDK. Всё, что приложение берёт у портала во фрейме, — здесь.

interface Bx24Auth {
  access_token: string;
  member_id: string;
  domain: string;
  expires_in?: number;
}

interface Bx24 {
  init(cb: () => void): void;
  getAuth(): Bx24Auth | false;
  refreshAuth(cb: (auth: Bx24Auth) => void): void;
  placement: { info(): { placement: string; options: Record<string, unknown> } };
  fitWindow(cb?: () => void): void;
  openPath?(path: string): void;
  im?: { openMessenger?(dialogId: string): void };
  selectUsers?(cb: (users: { id: string; name: string }[]) => void): void;
}

declare global {
  interface Window {
    BX24?: Bx24;
  }
}

export interface PlacementContext {
  placement: string;
  /** ID сделки, если приложение открыто во встройке карточки сделки. */
  dealId: number | null;
}

let ready: Promise<boolean> | null = null;

/** true — приложение открыто во фрейме Битрикс24 и SDK готов. */
export function initB24(timeoutMs = 4000): Promise<boolean> {
  if (ready) return ready;
  ready = new Promise((resolve) => {
    const sdk = window.BX24;
    if (!sdk || window.parent === window) return resolve(false);
    const timer = setTimeout(() => resolve(false), timeoutMs);
    sdk.init(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  return ready;
}

export interface B24Auth {
  token: string;
  memberId: string;
}

/** Обновлять токен заранее: за 5 минут до конца часа, а не после отказа. */
const REFRESH_AHEAD_MS = 5 * 60_000;
/** SDK может не вызвать callback refreshAuth (портал недоступен) — не ждём вечно. */
const REFRESH_TIMEOUT_MS = 15_000;

let cached: (B24Auth & { expiresAt: number }) | null = null;
let refreshing: Promise<B24Auth> | null = null;

function remember(a: Bx24Auth): B24Auth {
  // expires_in — сколько секунд осталось; без него считаем как у Битрикс24 — час.
  const ttl = Number(a.expires_in) > 0 ? Number(a.expires_in) * 1000 : 3600_000;
  cached = { token: a.access_token, memberId: a.member_id, expiresAt: Date.now() + ttl };
  return { token: cached.token, memberId: cached.memberId };
}

/**
 * Токен для запроса к API. После долгого бездействия `BX24.getAuth()` возвращает false
 * (токен истёк) — тогда, а также незадолго до истечения, берём новый у портала.
 */
export async function getAuth(): Promise<B24Auth | null> {
  if (cached && cached.expiresAt - Date.now() > REFRESH_AHEAD_MS) return { token: cached.token, memberId: cached.memberId };
  if (!cached) {
    const a = window.BX24?.getAuth();
    if (a && a.access_token) {
      const fresh = remember(a);
      if (cached!.expiresAt - Date.now() > REFRESH_AHEAD_MS) return fresh;
    }
  }
  if (!window.BX24) return null;
  return refreshAuth();
}

/** Новый токен у портала. Параллельные запросы ждут одно обновление. */
export function refreshAuth(): Promise<B24Auth> {
  refreshing ??= new Promise<B24Auth>((resolve, reject) => {
    const sdk = window.BX24;
    if (!sdk) return reject(new Error('BX24 SDK недоступен'));
    const timer = setTimeout(() => reject(new Error('Портал не ответил на обновление авторизации')), REFRESH_TIMEOUT_MS);
    sdk.refreshAuth((a) => {
      clearTimeout(timer);
      if (a?.access_token) resolve(remember(a));
      else reject(new Error('Не удалось обновить авторизацию'));
    });
  }).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export function placementContext(): PlacementContext {
  try {
    const info = window.BX24?.placement.info();
    const placement = info?.placement || 'DEFAULT';
    const raw = info?.options?.ID ?? info?.options?.ENTITY_ID;
    const dealId =
      placement.startsWith('CRM_DEAL') && raw !== undefined && /^\d+$/.test(String(raw)) ? Number(raw) : null;
    return { placement, dealId };
  } catch {
    return { placement: 'DEFAULT', dealId: null };
  }
}

/** Подогнать высоту фрейма под содержимое (во встройках фрейм не растёт сам). */
export function fitFrame(): void {
  try {
    window.BX24?.fitWindow();
  } catch {
    /* вне фрейма — нечего подгонять */
  }
}

/** Диалог может закрыться без callback — не блокируем форму ожиданием Promise. */
export function selectEmployees(onSelect: (users: { id: number; name: string }[]) => void): void {
  const sdk = window.BX24;
  if (!sdk?.selectUsers) throw new Error('Выбор сотрудников доступен только в Битрикс24');
  sdk.selectUsers((users) =>
    onSelect(
      users.map((u) => ({ id: Number(u.id), name: u.name })).filter((u) => Number.isSafeInteger(u.id) && u.id > 0),
    ),
  );
}

/** Открыть чат в мессенджере портала (поверх приложения). */
export function openMessenger(chatId: number): void {
  const sdk = window.BX24;
  if (sdk?.im?.openMessenger) sdk.im.openMessenger(`chat${chatId}`);
  else sdk?.openPath?.(`/online/?IM_DIALOG=chat${chatId}`);
}

/** Карточка CRM в слайдере портала. */
export function openCrm(type: 'lead' | 'contact' | 'company' | 'deal', id: number): void {
  window.BX24?.openPath?.(`/crm/${type}/details/${id}/`);
}
