/** Тема панели: светлая, тёмная или как в системе. Выбор — в браузере сотрудника (localStorage). */
export type ThemeChoice = 'light' | 'dark' | 'auto';

const KEY = 'btx24.theme';
const media = () => (typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null);

export function savedTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'dark' || v === 'auto' ? v : 'light';
  } catch {
    // Хранилище недоступно (приватный режим, запрет во фрейме) — светлая.
    return 'light';
  }
}

export function saveTheme(choice: ThemeChoice): void {
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    // Не запомнится — применится только до перезагрузки.
  }
}

let unwatch: (() => void) | null = null;

/** `data-theme` на <html>; «как в системе» — и следит за сменой темы системы. */
export function applyTheme(choice: ThemeChoice): void {
  unwatch?.();
  unwatch = null;
  const set = (dark: boolean) => document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  if (choice !== 'auto') return set(choice === 'dark');
  const m = media();
  set(!!m?.matches);
  if (!m) return;
  const on = (e: MediaQueryListEvent) => set(e.matches);
  m.addEventListener('change', on);
  unwatch = () => m.removeEventListener('change', on);
}

export const THEME_NEXT: Record<ThemeChoice, ThemeChoice> = { light: 'dark', dark: 'auto', auto: 'light' };
export const THEME_LABELS: Record<ThemeChoice, string> = { light: 'Светлая тема', dark: 'Тёмная тема', auto: 'Тема как в системе' };
