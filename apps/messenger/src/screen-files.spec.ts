import { mkdtemp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { Page } from 'puppeteer';
import { FileOffers, SCREEN_FILE_TTL_MS, ScreenFiles, safeName } from './screen-files.js';

const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('Файлы для экрана мессенджера', () => {
  it('хранятся с исходным именем и удаляются через час', async () => {
    const dir = await mkdtemp(`${tmpdir()}/screen-files-`);
    let now = Date.parse('2026-10-24T10:00:00Z');
    const files = new ScreenFiles(dir, () => now);
    const f = await files.put('wa1', { name: '../Договор №5.pdf', mime: 'application/pdf', data: b64('pdf') });
    expect(f).toMatchObject({ name: 'Договор №5.pdf', size: 3, expiresAt: '2026-10-24T11:00:00.000Z', attachedAt: null });
    expect((await stat(files.path('wa1', f))).size).toBe(3);
    expect((await files.list('wa1')).map((x) => x.id)).toEqual([f.id]);
    now += SCREEN_FILE_TTL_MS + 1;
    expect(await files.list('wa1')).toEqual([]);
    expect(await readdir(`${dir}/screen-files/wa1`)).toEqual([]);
  });

  it('имя без каталогов и управляющих символов', () => {
    expect(safeName('/etc/passwd')).toBe('passwd');
    expect(safeName('a\u0000b\nc.txt')).toBe('abc.txt');
    expect(safeName('..')).toBe('file');
  });

  it('файл подставляется в окно выбора файла, перехват потом выключается', async () => {
    const accept = vi.fn(async () => undefined);
    const send = vi.fn(async () => undefined);
    const page = { waitForFileChooser: vi.fn(async () => ({ accept })), _client: () => ({ send }) } as unknown as Page;
    const offers = new FileOffers();
    const attached = vi.fn(async () => undefined);
    await offers.offer('wa1', page, 'f1', '/data/x.pdf', attached);
    await vi.waitFor(() => expect(attached).toHaveBeenCalled());
    expect(accept).toHaveBeenCalledWith(['/data/x.pdf']);
    expect(send).toHaveBeenCalledWith('Page.setInterceptFileChooserDialog', { enabled: false });
    expect(offers.current('wa1')).toBeNull();
  });

  it('новое «прикрепить» отменяет прежнее ожидание', async () => {
    const send = vi.fn(async () => undefined);
    const page = {
      waitForFileChooser: vi.fn(({ signal }: { signal: AbortSignal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))),
      _client: () => ({ send }),
    } as unknown as Page;
    const offers = new FileOffers();
    await offers.offer('wa1', page, 'f1', '/a', async () => undefined);
    await offers.offer('wa1', page, 'f2', '/b', async () => undefined);
    expect(offers.current('wa1')?.fileId).toBe('f2');
    await offers.cancel('wa1');
    expect(offers.current('wa1')).toBeNull();
  });
});
