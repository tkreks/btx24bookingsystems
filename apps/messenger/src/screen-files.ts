import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { CDPSession, Page } from 'puppeteer';

/** Файл для экрана живёт час (решение владельца 2026-10-24), потом удаляется. */
export const SCREEN_FILE_TTL_MS = 60 * 60_000;
/** Сколько ждать, пока сотрудник нажмёт «прикрепить» в окне мессенджера. */
export const OFFER_TIMEOUT_MS = 3 * 60_000;
export const MAX_SCREEN_FILE_BYTES = 64 * 1024 * 1024;
const FILE_ID_RE = /^[0-9a-f]{24}$/;

/** Файл, загруженный сотрудником для отправки с экрана мессенджера (VNC). */
export interface ScreenFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  createdAt: string;
  expiresAt: string;
  /** Когда файл подставлен в окно выбора файла мессенджера. */
  attachedAt: string | null;
}

/** Имя без каталогов и управляющих символов — с ним файл и уйдёт клиенту. */
export function safeName(name: unknown): string {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/\p{Cc}/gu, '').trim().slice(0, 150);
  return clean && clean !== '.' && clean !== '..' ? clean : 'file';
}

/**
 * Файлы для экрана мессенджера: `dataDir/screen-files/<экземпляр>/<id>/<имя>` + `<id>.json`. Браузер
 * экземпляра работает в том же контейнере, поэтому файл можно подставить в его окно выбора файла.
 * Старше часа — удаляются (`sweep` по таймеру и при каждом чтении списка).
 */
export class ScreenFiles {
  constructor(
    private readonly dataDir: string,
    private readonly now: () => number = Date.now,
  ) {}

  private root() {
    return `${this.dataDir}/screen-files`;
  }

  private dir(instanceId: string) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(instanceId)) throw new Error('invalid instance id');
    return `${this.root()}/${instanceId}`;
  }

  async put(instanceId: string, f: { name: unknown; mime: unknown; data: string }): Promise<ScreenFile> {
    if (f.data.length > Math.ceil(MAX_SCREEN_FILE_BYTES / 3) * 4) throw new Error('Файл больше 64 МБ');
    const data = Buffer.from(f.data, 'base64');
    if (!data.length) throw new Error('Пустой файл');
    if (data.length > MAX_SCREEN_FILE_BYTES) throw new Error('Файл больше 64 МБ');
    const id = randomBytes(12).toString('hex');
    const at = this.now();
    const file: ScreenFile = {
      id,
      name: safeName(f.name),
      mime: typeof f.mime === 'string' && f.mime ? f.mime.slice(0, 200) : 'application/octet-stream',
      size: data.length,
      createdAt: new Date(at).toISOString(),
      expiresAt: new Date(at + SCREEN_FILE_TTL_MS).toISOString(),
      attachedAt: null,
    };
    const dir = this.dir(instanceId);
    await mkdir(`${dir}/${id}`, { recursive: true });
    await writeFile(`${dir}/${id}/${file.name}`, data);
    await writeFile(`${dir}/${id}.json`, JSON.stringify(file));
    return file;
  }

  async get(instanceId: string, id: string): Promise<ScreenFile | null> {
    if (!FILE_ID_RE.test(id)) return null;
    const f = await readFile(`${this.dir(instanceId)}/${id}.json`, 'utf8').then((s) => JSON.parse(s) as ScreenFile, () => null);
    return f && Date.parse(f.expiresAt) > this.now() ? f : null;
  }

  /** Путь к файлу на диске (для окна выбора файла браузера). */
  path(instanceId: string, f: ScreenFile): string {
    return `${this.dir(instanceId)}/${f.id}/${f.name}`;
  }

  async list(instanceId: string): Promise<ScreenFile[]> {
    await this.sweep();
    const names = await readdir(this.dir(instanceId)).catch(() => [] as string[]);
    const files = await Promise.all(names.filter((n) => n.endsWith('.json')).map((n) => this.get(instanceId, n.slice(0, -5))));
    return files.filter((f): f is ScreenFile => !!f).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async markAttached(instanceId: string, id: string): Promise<void> {
    const f = await this.get(instanceId, id);
    if (f) await writeFile(`${this.dir(instanceId)}/${id}.json`, JSON.stringify({ ...f, attachedAt: new Date(this.now()).toISOString() }));
  }

  async remove(instanceId: string, id: string): Promise<void> {
    if (!FILE_ID_RE.test(id)) return;
    await rm(`${this.dir(instanceId)}/${id}`, { recursive: true, force: true });
    await rm(`${this.dir(instanceId)}/${id}.json`, { force: true });
  }

  /** Удалить всё старше часа — у всех экземпляров (и файлы без описания). */
  async sweep(): Promise<void> {
    const instances = await readdir(this.root()).catch(() => [] as string[]);
    for (const inst of instances) {
      const dir = `${this.root()}/${inst}`;
      const names = await readdir(dir).catch(() => [] as string[]);
      const alive = new Set<string>();
      for (const n of names.filter((x) => x.endsWith('.json'))) {
        const f = await readFile(`${dir}/${n}`, 'utf8').then((s) => JSON.parse(s) as ScreenFile, () => null);
        if (f && Date.parse(f.expiresAt) > this.now()) alive.add(n.slice(0, -5));
      }
      for (const n of names) if (!alive.has(n.replace(/\.json$/, ''))) await rm(`${dir}/${n}`, { recursive: true, force: true });
    }
  }
}

type Offer = { fileId: string; until: string; abort: AbortController; done: Promise<void> };

/**
 * «Прикрепить» файл в окне мессенджера: следующее окно выбора файла на странице экземпляра получает
 * этот файл (сотрудник нажимает 📎 на экране — файл подставляется сам). Одно ожидание на экземпляр;
 * по окончании перехват окна выключается, иначе обычный выбор файла на экране перестал бы открываться.
 */
export class FileOffers {
  private readonly offers = new Map<string, Offer>();

  current(instanceId: string): { fileId: string; until: string } | null {
    const o = this.offers.get(instanceId);
    return o ? { fileId: o.fileId, until: o.until } : null;
  }

  async offer(instanceId: string, page: Page, fileId: string, path: string, onAttached: () => Promise<void>, timeoutMs = OFFER_TIMEOUT_MS): Promise<{ fileId: string; until: string }> {
    await this.cancel(instanceId);
    const abort = new AbortController();
    const until = new Date(Date.now() + timeoutMs).toISOString();
    const done = (async () => {
      try {
        const chooser = await page.waitForFileChooser({ timeout: timeoutMs, signal: abort.signal });
        await chooser.accept([path]);
        await onAttached();
      } catch {
        // Не нажали за отведённое время или отменили — файл остаётся в списке.
      } finally {
        await (page as unknown as { _client(): CDPSession })._client().send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => undefined);
        if (this.offers.get(instanceId)?.abort === abort) this.offers.delete(instanceId);
      }
    })();
    this.offers.set(instanceId, { fileId, until, abort, done });
    return { fileId, until };
  }

  async cancel(instanceId: string): Promise<void> {
    const o = this.offers.get(instanceId);
    if (!o) return;
    o.abort.abort();
    await o.done;
  }
}
