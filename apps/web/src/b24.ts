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

export function currentAuth(): { token: string; memberId: string } | null {
  const a = window.BX24?.getAuth();
  return a && a.access_token ? { token: a.access_token, memberId: a.member_id } : null;
}

/** Новый токен у портала (по истечении часа). */
export function refreshAuth(): Promise<{ token: string; memberId: string }> {
  return new Promise((resolve, reject) => {
    const sdk = window.BX24;
    if (!sdk) return reject(new Error('BX24 SDK недоступен'));
    sdk.refreshAuth((a) =>
      a?.access_token
        ? resolve({ token: a.access_token, memberId: a.member_id })
        : reject(new Error('Не удалось обновить авторизацию')),
    );
  });
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
