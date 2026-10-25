import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import type { Browser, Page } from 'puppeteer';
import { SCREEN } from './screen.js';
import type { MessengerKind } from './spec.js';

export const MESSENGER_URLS: Record<MessengerKind, string> = {
  whatsapp: 'https://web.whatsapp.com/', telegram: 'https://web.telegram.org/k/', max: 'https://web.max.ru/',
};

/** Убираем только информационную панель Chromium; остальные аргументы Puppeteer сохраняются. */
export const BROWSER_IGNORE_ARGS = ['--enable-automation'];
export function messengerBrowserArgs(kind: MessengerKind, proxy?: string): string[] {
  return ['--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    '--noerrdialogs', '--hide-crash-restore-bubble', '--lang=ru-RU',
    `--window-size=${SCREEN.width},${SCREEN.height}`, '--window-position=0,0', '--kiosk',
    `--app=${MESSENGER_URLS[kind]}`, ...(kind !== 'max' && proxy ? [`--proxy-server=${proxy}`] : [])];
}

/** Меняем только настройки оболочки до запуска; cookies/авторизацию и остальные prefs сохраняем. */
export async function prepareBrowserProfile(profile: string): Promise<void> {
  await mkdir(`${profile}/Default`, { recursive: true });
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) await rm(`${profile}/${f}`, { force: true });
  let prefs: Record<string, unknown> = {};
  try {
    const raw: unknown = JSON.parse(await readFile(`${profile}/Default/Preferences`, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid preferences');
    prefs = raw as Record<string, unknown>;
  }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Не удалось прочитать настройки профиля браузера'); }
  const section = (key: string): Record<string, unknown> => prefs[key] && typeof prefs[key] === 'object' && !Array.isArray(prefs[key]) ? prefs[key] as Record<string, unknown> : {};
  prefs.profile = { ...section('profile'), exit_type: 'Normal', exited_cleanly: true };
  prefs.intl = { ...section('intl'), accept_languages: 'ru-RU,ru,en-US,en', selected_languages: 'ru-RU,ru' };
  prefs.session = { ...section('session'), restore_on_startup: 5 };
  prefs.translate = { ...section('translate'), enabled: false };
  prefs.credentials_enable_service = false;
  const tmp = `${profile}/Default/Preferences.btx-${process.pid}`;
  await writeFile(tmp, JSON.stringify(prefs), { mode: 0o600 });
  await rename(tmp, `${profile}/Default/Preferences`);
}

/** Политика образа защищает все окна; здесь дополнительно оставляем одну страницу своего сервиса. */
export async function configureMessengerBrowser(browser: Browser, page: Page, kind: MessengerKind): Promise<void> {
  const closeOther = async (other: Page | null) => { if (other && other !== page) await other.close().catch(() => undefined); };
  browser.on('targetcreated', target => { if (target.type() === 'page') void target.page().then(closeOther).catch(() => undefined); });
  for (const other of await browser.pages()) await closeOther(other);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.5' });
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setLocaleOverride', { locale: 'ru_RU' });
  // Сессия остаётся прикреплённой до закрытия страницы: detach сбрасывает locale override.
  // Не используем request interception: whatsapp-web.js сам перехватывает HTML из кэша.
  await page.evaluateOnNewDocument((origin: string) => {
    // Не открываем вторые окна даже для разрешённого сервиса.
    window.open = () => null;
    window.addEventListener('click', e => {
      const link = (e.target as Element | null)?.closest?.('a');
      if (!link || link.download) return;
      if ((link.target && link.target !== '_self') || e.ctrlKey || e.metaKey || e.shiftKey || new URL(link.href, location.href).origin !== origin) e.preventDefault();
    }, true);
  }, new URL(MESSENGER_URLS[kind]).origin);
}
