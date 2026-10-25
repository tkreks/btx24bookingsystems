import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BROWSER_IGNORE_ARGS, messengerBrowserArgs, prepareBrowserProfile } from './browser.js';

describe('браузер мессенджеров', () => {
  it('убирает панель автоматизации и запускает один экран приложения; MAX остаётся без прокси', () => {
    expect(BROWSER_IGNORE_ARGS).toEqual(['--enable-automation']);
    expect(messengerBrowserArgs('telegram', 'http://proxy.test:8080')).toEqual(expect.arrayContaining(['--kiosk', '--app=https://web.telegram.org/k/', '--lang=ru-RU', '--proxy-server=http://proxy.test:8080']));
    expect(messengerBrowserArgs('max', 'http://proxy.test:8080').some(a => a.startsWith('--proxy-server'))).toBe(false);
  });
  it('исправляет crashed prefs, сохраняя чужие настройки и не меняя данные входа', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'btx-browser-'));
    try {
      await mkdir(join(profile, 'Default'));
      await writeFile(join(profile, 'Default', 'Preferences'), JSON.stringify({ profile: { exit_type: 'Crashed', keep: 42 }, unrelated: { value: 'keep' } }));
      await writeFile(join(profile, 'Default', 'Cookies'), 'session-test');
      await writeFile(join(profile, 'SingletonLock'), 'old');
      await prepareBrowserProfile(profile);
      const prefs = JSON.parse(await readFile(join(profile, 'Default', 'Preferences'), 'utf8'));
      expect(prefs.profile).toEqual({ exit_type: 'Normal', exited_cleanly: true, keep: 42 });
      expect(prefs.intl.accept_languages).toBe('ru-RU,ru,en-US,en');
      expect(prefs.unrelated).toEqual({ value: 'keep' });
      expect(await readFile(join(profile, 'Default', 'Cookies'), 'utf8')).toBe('session-test');
      await expect(readFile(join(profile, 'SingletonLock'))).rejects.toMatchObject({ code: 'ENOENT' });
      await prepareBrowserProfile(profile);
    } finally { await rm(profile, { recursive: true, force: true }); }
  });
  it('не затирает повреждённые prefs', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'btx-browser-invalid-'));
    try {
      await mkdir(join(profile, 'Default'));
      await writeFile(join(profile, 'Default', 'Preferences'), '{broken');
      await expect(prepareBrowserProfile(profile)).rejects.toThrow('Не удалось прочитать');
      expect(await readFile(join(profile, 'Default', 'Preferences'), 'utf8')).toBe('{broken');
    } finally { await rm(profile, { recursive: true, force: true }); }
  });
});
