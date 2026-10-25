import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import type { InstanceConfig, OutgoingMedia } from './instance.js';
import { BROWSER_IGNORE_ARGS, configureMessengerBrowser, messengerBrowserArgs, prepareBrowserProfile } from './browser.js';
import type { WireEvent, WireMessage } from './messages.js';
import { AVATAR_TTL_MS, avatarKey, defaultName, MAX_MEDIA_BYTES, MediaStore, type WireMedia } from './media.js';
import {
  contactOfChat,
  decodeFrame,
  dialogIdOf,
  encodeFrame,
  eventsOf,
  idStr,
  isClientContact,
  mediaTypeOf,
  newMemory,
  OP,
  parseWireId,
  phoneOf,
  remember,
  toWire,
  type MaxChat,
  type MaxContact,
  type MaxMessage,
} from './max-wire.js';
import { VirtualScreen } from './screen.js';
import type { InstanceSpec, InstanceState, InstanceStatus } from './spec.js';

export const MAX_URL = 'https://web.max.ru/';
/** Как часто проверять вход (сам вход и изменения переписки приходят событиями страницы). */
const POLL_MS = 10_000;
/** Ответ MAX на свою команду — не дольше. */
const CMD_TIMEOUT_MS = 30_000;

interface SavedState {
  /** Время (мс) последнего переданного в api сообщения — после перезапуска дочитываем с него. */
  time: number;
  contacts: Record<string, { id: string; phone?: string; name?: string; flags?: number }>;
}

/** Ошибка MAX на команду: `{ error: 'not.found', message }` (кадр `cmd = 3`). */
class MaxError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message || code);
  }
}

/**
 * Скрипт страницы (до её загрузки): своя обёртка `WebSocket` для соединения MAX. Кадры сервера
 * (события, ответ на вход) уходят в сервис (`__btxFrame`), свои команды сервис шлёт в то же соединение
 * (`__btxSend`) с отрицательным `seq` — страница нумерует свои с нуля вверх, так номера не пересекаются;
 * ответы на свои команды странице не показываются.
 */
function pageHook() {
  const w = window as unknown as { WebSocket: typeof WebSocket; __btxSock?: WebSocket; __btxFrame?: (b64: string) => void; __btxSend?: (b64: string) => boolean };
  if ((w.WebSocket as unknown as { __btx?: boolean }).__btx) return;
  const b64 = (buf: ArrayBuffer) => {
    const u = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const Native = w.WebSocket;
  class BtxSocket extends Native {
    static __btx = true;
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      if (!/oneme\.ru/.test(String(url))) return;
      w.__btxSock = this;
      let app: ((ev: MessageEvent) => unknown) | null = null;
      Object.defineProperty(this, 'onmessage', { configurable: true, get: () => app, set: (h) => {
        app = h;
      } });
      Native.prototype.addEventListener.call(this, 'message', ((ev: MessageEvent) => {
        const d = ev.data;
        if (!(d instanceof ArrayBuffer) || d.byteLength < 10) return app?.call(this, ev);
        const v = new DataView(d);
        const cmd = v.getUint8(1);
        const seq = v.getInt16(2);
        const op = v.getInt16(4);
        const ours = seq < 0 && cmd !== 0;
        if (ours || (cmd === 0 && op !== 1) || op === 19 || op === 20) w.__btxFrame?.(b64(d));
        if (!ours) app?.call(this, ev);
      }) as EventListener);
    }
  }
  w.WebSocket = BtxSocket as unknown as typeof WebSocket;
  w.__btxSend = (data: string) => {
    const s = w.__btxSock;
    if (!s || s.readyState !== 1) return false;
    s.send(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
    return true;
  };
}

/**
 * MAX (ADR 0014): как Telegram — виртуальный экран Xvfb `:N`, VNC и Chromium с web.max.ru; профиль
 * браузера (вход) — `dataDir/sessions/session-<id>`. Библиотеки нет, разметку страницы не разбираем:
 * говорим протоколом самой страницы через её же соединение (`pageHook`, кадры — `max-wire.ts`).
 * Вход — на экране (QR или номер и код из SMS). Изменения — события сервера; пропущенное за время
 * простоя дочитывается историей чатов с временем новее сохранённого (`dataDir/max-<id>.json`).
 */
export class MaxInstance {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private status: InstanceStatus;
  private readonly media: MediaStore;
  private readonly screen = new VirtualScreen();
  private timer: NodeJS.Timeout | null = null;
  private state: SavedState | null = null;
  private readonly contacts = new Map<string, MaxContact>();
  private readonly chats = new Map<string, MaxChat>();
  private readonly mem = newMemory();
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  /** Обработанные файлы (событие 136): после загрузки файл можно отправить только когда MAX его принял. */
  private readonly attachWaiters = new Map<string, () => void>();
  private nextSeq = -1;
  private me = '';
  private wasReady = false;
  private loadedAt = 0;

  constructor(
    readonly spec: InstanceSpec,
    private readonly config: InstanceConfig,
    private readonly log: (msg: string) => void = (m) => console.log(m),
    private readonly emit: (e: WireEvent) => void = () => undefined,
  ) {
    this.media = new MediaStore(config.dataDir);
    this.status = { id: spec.id, kind: spec.kind, phone: spec.phone, auth: spec.auth, state: 'stopped', code: null, qr: null, account: null, error: null, updatedAt: new Date().toISOString() };
  }

  get info(): InstanceStatus {
    return this.status;
  }

  private set(state: InstanceState, patch: Partial<InstanceStatus> = {}) {
    if (this.status.state === state && !patch.error && !patch.account) return;
    this.status = { ...this.status, code: null, qr: null, error: null, ...patch, state, updatedAt: new Date().toISOString() };
    this.log(`[${this.spec.id}] max ${state}${patch.error ? `: ${patch.error}` : ''}`);
  }

  private get profile() {
    return `${this.config.dataDir}/sessions/session-${this.spec.id}`;
  }
  private get stateFile() {
    return `${this.config.dataDir}/max-${this.spec.id}.json`;
  }

  async start(): Promise<void> {
    if (this.browser) return;
    this.set('starting');
    try {
      // MAX — без прокси: и без флага Chromium, и без переменных прокси в окружении браузера.
      const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/proxy/i.test(k)));
      if (this.config.display) {
        await this.screen.start(this.spec.display);
        env.DISPLAY = `:${this.spec.display}`;
      }
      await mkdir(this.profile, { recursive: true });
      await prepareBrowserProfile(this.profile);
      this.state = await readFile(this.stateFile, 'utf8').then((s) => JSON.parse(s) as SavedState, () => null);
      for (const c of Object.values(this.state?.contacts ?? {}))
        this.contacts.set(c.id, { id: Number(c.id), phone: c.phone, names: c.name ? [{ name: c.name }] : [], flags: c.flags });
      const browser = await puppeteer.launch({
        executablePath: this.config.chromium,
        headless: !this.config.display,
        userDataDir: this.profile,
        env,
        defaultViewport: null,
        // MAX доступен с сервера напрямую — без прокси мессенджеров (он для WhatsApp и Telegram).
        ignoreDefaultArgs: BROWSER_IGNORE_ARGS,
        args: messengerBrowserArgs('max'),
      });
      this.browser = browser;
      browser.on('disconnected', () => {
        if (this.browser !== browser) return;
        this.browser = this.page = null;
        this.stopTimer();
        this.set('disconnected', { error: 'Браузер MAX закрылся' });
      });
      const page = (await browser.pages())[0] ?? (await browser.newPage());
      this.page = page;
      await configureMessengerBrowser(browser, page, 'max');
      await page.exposeFunction('__btxFrame', (b64: string) => void this.onFrame(b64));
      await page.evaluateOnNewDocument(pageHook);
      page.on('load', () => (this.loadedAt = Date.now()));
      await page.goto(MAX_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      this.loadedAt = Date.now();
      this.timer = setInterval(() => void this.tick(), POLL_MS);
    } catch (err) {
      this.set('failed', { error: err instanceof Error ? err.message : String(err) });
      await this.stop(false);
    }
  }

  async stop(resetState = true): Promise<void> {
    this.stopTimer();
    const browser = this.browser;
    this.browser = this.page = null;
    this.failPending(new Error('Мессенджер остановлен'));
    await browser?.close().catch(() => undefined);
    this.screen.stop();
    this.wasReady = false;
    if (resetState) this.set('stopped');
  }

  /** Выйти из аккаунта (сеанс в «Настройки → Устройства» завершается) и остановиться. */
  async logout(): Promise<void> {
    if (this.status.state === 'ready') await this.cmd(OP.logout, {}).catch(() => undefined);
    await this.stop();
    await rm(this.stateFile, { force: true });
  }

  private stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private failPending(err: Error) {
    for (const [seq, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(seq);
    }
  }

  /** Вход: сохранённый токен страницы есть, а ответа на вход (19) ещё нет — ждём; токена нет — вход на экране. */
  private async tick(): Promise<void> {
    if (!this.page) return;
    const s = await this.page.evaluate(() => ({ auth: !!localStorage.getItem('__oneme_auth'), sock: (window as unknown as { __btxSock?: WebSocket }).__btxSock?.readyState ?? -1 })).catch(() => null);
    if (!s) return;
    if (!s.auth) {
      if (this.wasReady) this.loggedOut();
      // Страница ещё грузится — не мигаем «войдите на экране».
      else if (this.status.state !== 'logged_out' && Date.now() - this.loadedAt > 5_000) this.set('qr');
      return;
    }
    if (!this.wasReady && this.status.state !== 'authenticated') this.set('authenticated');
  }

  private loggedOut() {
    this.wasReady = false;
    this.me = '';
    this.state = null;
    void rm(this.stateFile, { force: true });
    this.failPending(new Error('Сеанс MAX завершён'));
    this.set('logged_out', { error: 'Сеанс завершён в MAX — войдите заново на экране' });
  }

  /** Кадр из страницы: ответ на свою команду, ответ на вход или событие сервера. */
  private async onFrame(b64: string): Promise<void> {
    let f;
    try {
      f = decodeFrame(Buffer.from(b64, 'base64'));
    } catch (err) {
      this.log(`[${this.spec.id}] max: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (f.seq < 0 && f.cmd !== 0) {
      const p = this.pending.get(f.seq);
      if (!p) return;
      this.pending.delete(f.seq);
      clearTimeout(p.timer);
      const e = (f.payload ?? {}) as { error?: string; message?: string; localizedMessage?: string };
      if (f.cmd === 3) p.reject(new MaxError(String(e.error ?? 'unknown'), String(e.localizedMessage ?? e.message ?? e.error ?? 'Ошибка MAX')));
      else p.resolve(f.payload);
      return;
    }
    try {
      if (f.opcode === OP.login && f.cmd === 1) await this.onLogin(f.payload as LoginPayload);
      else if (f.opcode === OP.login && f.cmd === 3) {
        const code = String((f.payload as { error?: string })?.error ?? '');
        if (['login.token', 'login.blocked', 'user.not.found'].includes(code)) this.loggedOut();
      } else if (f.opcode === OP.logout && this.wasReady) this.loggedOut();
      else if (f.cmd === 0) await this.onEvent(f.opcode, f.payload);
    } catch (err) {
      this.log(`[${this.spec.id}] max событие ${f.opcode}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Вход выполнен (и после каждого переподключения страницы): профиль, чаты, догон пропущенного. */
  private async onLogin(p: LoginPayload): Promise<void> {
    const me = p?.profile?.contact;
    if (!me) return;
    this.me = idStr(me.id);
    this.learn(p.contacts ?? []);
    for (const c of p.chats ?? []) this.chats.set(idStr(c.id), c);
    const phone = phoneOf(me) ?? '';
    const first = !this.wasReady;
    this.wasReady = true;
    if (first)
      this.set('ready', {
        account: phone ? `${phone}@c.us` : null,
        error: phone && phone !== this.spec.phone ? `Вход выполнен с другим номером: +${phone}` : null,
      });
    if (!this.state?.time) {
      // Первый вход: прошлое — только по «Загрузить историю», дальше — с этого момента.
      this.state = { time: Date.now(), contacts: this.state?.contacts ?? {} };
      await this.save();
      return;
    }
    await this.catchUp(this.state.time).catch((err: unknown) => this.log(`[${this.spec.id}] max догон: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** Чаты с событиями новее `since` — их сообщения после `since` (повтор api примет идемпотентно). */
  private async catchUp(since: number): Promise<void> {
    const chats = [...this.chats.values()].filter((c) => c.type === 'DIALOG' && (c.lastEventTime ?? 0) > since);
    for (const c of chats.slice(0, 100)) {
      const h = await this.cmd<{ messages?: MaxMessage[] }>(OP.history, { chatId: BigInt(idStr(c.id)), from: since, forward: 100, backward: 0, getMessages: true });
      await this.ensureContacts([this.peerOf(c.id)]);
      for (const m of h.messages ?? []) {
        if (m.time <= since || m.status === 'REMOVED') continue;
        const w = toWire(c.id, m, this.me, this.contacts);
        if (!w) continue;
        remember(this.mem, w, m.time);
        await this.deliver(w, m, c.id);
      }
    }
  }

  private async onEvent(opcode: number, payload: unknown): Promise<void> {
    if (!this.wasReady) return;
    const p = (payload ?? {}) as { chatId?: unknown; chat?: MaxChat; fileId?: unknown; videoId?: unknown };
    if (opcode === OP.notifAttach) {
      const id = idStr(p.fileId ?? p.videoId);
      this.attachWaiters.get(id)?.();
      return;
    }
    if (p.chat?.id != null) this.chats.set(idStr(p.chat.id), p.chat);
    if (opcode === OP.notifMessage && p.chatId != null) await this.ensureContacts([this.peerOf(p.chatId)]);
    const { events, message } = eventsOf(this.spec.id, opcode, payload, this.me, this.contacts, this.mem);
    if (message) await this.deliver(message.wire, message.raw, p.chatId);
    for (const e of events) this.emit(e);
  }

  private peerOf(chatId: unknown): string {
    return String(BigInt(idStr(chatId)) ^ BigInt(this.me));
  }

  /** Новое сообщение → api; вложение скачивается сразу (для открытой линии нужна ссылка на файл). */
  private async deliver(wire: WireMessage, raw: MaxMessage, chatId: unknown): Promise<void> {
    const media = wire.hasMedia ? await this.download(chatId, raw, wire).catch((err: unknown) => (this.log(`[${this.spec.id}] max файл: ${err instanceof Error ? err.message : String(err)}`), null)) : null;
    this.emit({ type: 'message', instanceId: this.spec.id, message: media ? { ...wire, media } : wire });
    if (this.state && raw.time > this.state.time) {
      this.state.time = raw.time;
      await this.save();
    }
  }

  private learn(contacts: MaxContact[]) {
    let changed = false;
    for (const c of contacts) {
      const id = idStr(c.id);
      if (!id) continue;
      this.contacts.set(id, c);
      if (!this.state) continue;
      const next = { id, phone: phoneOf(c) ?? undefined, name: c.names?.[0] ? (c.names[0].name ?? [c.names[0].firstName, c.names[0].lastName].filter(Boolean).join(' ')) : undefined, flags: c.flags };
      const prev = this.state.contacts[id];
      if (!prev || prev.phone !== next.phone || prev.name !== next.name) {
        this.state.contacts[id] = next;
        changed = true;
      }
    }
    return changed;
  }

  /** Имя и номер собеседников, которых ещё не знаем (команда 32). */
  private async ensureContacts(ids: string[]): Promise<void> {
    const need = ids.filter((id) => id && id !== '0' && !this.contacts.has(id));
    if (!need.length) return;
    const r = await this.cmd<{ contacts?: MaxContact[] }>(OP.contacts, { contactIds: need.map((x) => BigInt(x)) }).catch(() => null);
    if (r?.contacts && this.learn(r.contacts)) await this.save();
  }

  private async save(): Promise<void> {
    if (this.state) await writeFile(this.stateFile, JSON.stringify(this.state));
  }

  /** Своя команда MAX через соединение страницы; ошибка MAX — `MaxError` с её кодом. */
  private cmd<T>(opcode: number, payload: unknown): Promise<T> {
    const page = this.page;
    if (!page || !this.wasReady) return Promise.reject(new Error('Мессенджер не подключён'));
    const seq = this.nextSeq;
    this.nextSeq = seq <= -30_000 ? -1 : seq - 1;
    const frame = encodeFrame({ cmd: 0, seq, opcode, payload }).toString('base64');
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error('MAX не ответил вовремя'));
      }, CMD_TIMEOUT_MS);
      this.pending.set(seq, { resolve: resolve as (v: unknown) => void, reject, timer });
      page
        .evaluate((d) => (window as unknown as { __btxSend?: (d: string) => boolean }).__btxSend?.(d) ?? false, frame)
        .then((sent) => {
          if (sent) return;
          clearTimeout(timer);
          this.pending.delete(seq);
          reject(new Error('Нет соединения с MAX — подождите и повторите'));
        })
        .catch((err: unknown) => {
          clearTimeout(timer);
          this.pending.delete(seq);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }

  private ready() {
    if (!this.page || this.status.state !== 'ready' || !this.me) throw new Error('Мессенджер не подключён');
  }

  /** Собеседник по номеру: известный или поиск MAX (46). null — номера нет в MAX. */
  private async contactByPhone(phone: string): Promise<MaxContact | null> {
    const known = [...this.contacts.values()].find((c) => phoneOf(c) === phone);
    if (known) return known;
    const r = await this.cmd<{ contact?: MaxContact }>(OP.contactByPhone, { phone: `+${phone}` }).catch((err: unknown) => {
      if (err instanceof MaxError && /not\.found/.test(err.code)) return null;
      throw err;
    });
    if (!r?.contact) return null;
    if (this.learn([r.contact])) await this.save();
    return r.contact;
  }

  /** Проверка регистрации — без отправки сообщения. */
  async contact(phone: string): Promise<{ exists: boolean; chatId: string | null }> {
    const digits = phone.replace(/\D/g, '');
    if (!/^\d{11,15}$/.test(digits)) throw new Error('Некорректный номер');
    this.ready();
    const c = await this.contactByPhone(digits);
    return { exists: !!c, chatId: c ? `${idStr(c.id)}@lid` : null };
  }

  /** Куда писать: `<номер>@c.us` (найти по номеру) или `<contactId>@lid` (известный собеседник). */
  private async peer(to: string): Promise<{ contactId: string; chatId: bigint }> {
    let contactId = contactOfChat(to);
    if (!contactId) {
      const digits = to.replace(/@.*$/, '').replace(/\D/g, '');
      if (!/^\d{10,15}$/.test(digits)) throw new Error('Некорректный получатель');
      const c = await this.contactByPhone(digits);
      if (!c) throw new Error(`Номера +${digits} нет в MAX`);
      contactId = idStr(c.id);
    }
    if (!isClientContact(this.contacts.get(contactId)) && this.contacts.has(contactId)) throw new Error('Писать ботам и официальным аккаунтам MAX нельзя');
    return { contactId, chatId: dialogIdOf(this.me, contactId) };
  }

  async send(to: string, text: string, quotedId?: string, file?: OutgoingMedia): Promise<WireMessage> {
    if (file && (file.data.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4 || Buffer.byteLength(file.data, 'base64') > MAX_MEDIA_BYTES)) throw new Error('Файл больше 64 МБ');
    this.ready();
    const { contactId, chatId } = await this.peer(to);
    const quoted = quotedId ? parseWireId(quotedId) : null;
    const attaches = file ? [await this.upload(file)] : undefined;
    const r = await this.cmd<{ chatId: unknown; message: MaxMessage }>(OP.send, {
      chatId,
      message: { cid: BigInt(Date.now()), text, attaches, link: quoted ? { type: 'REPLY', messageId: quoted.messageId } : undefined },
      notify: true,
    });
    const wire = toWire(r.chatId ?? chatId, r.message, this.me, this.contacts);
    if (!wire) throw new Error('Сообщение отправлено, но MAX вернул неожиданный ответ — проверьте в чате');
    remember(this.mem, wire, r.message.time);
    // Своё вложение — сразу в хранилище (данные уже есть, качать не нужно).
    const saved = file ? await this.media.save(this.spec.id, wire.id, { mimetype: file.mime, data: file.data, filename: file.name }) : null;
    return { ...wire, ...(saved ? { media: saved, hasMedia: true } : {}), phone: phoneOf(this.contacts.get(contactId)) || (to.endsWith('@c.us') ? to.replace(/@.*$/, '') : null) };
  }

  /**
   * Файл в MAX: фото — `80` → POST формой → `photoToken`; прочее — `87` → POST телом с
   * `Content-Range` → ждём событие обработки (136) → вложение `FILE` по `fileId`. Так же грузит страница.
   */
  private async upload(file: OutgoingMedia): Promise<object> {
    const data = Buffer.from(file.data, 'base64');
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mime)) {
      const { url } = await this.cmd<{ url: string }>(OP.photoUpload, { count: 1 });
      const form = new FormData();
      form.append('file', new Blob([data], { type: file.mime }), file.name);
      const res = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) });
      const body = (await res.json().catch(() => null)) as { photos?: Record<string, { token?: string }>; error_code?: unknown } | null;
      const token = body?.photos ? Object.values(body.photos)[0]?.token : undefined;
      if (!res.ok || !token) throw new Error(`MAX не принял фото (${res.status})`);
      return { _type: 'PHOTO', photoToken: token };
    }
    const r = await this.cmd<{ info: { url: string; fileId: number | bigint }[] }>(OP.fileUpload, { count: 1 });
    const info = r.info?.[0];
    if (!info?.url) throw new Error('MAX не выдал адрес для загрузки файла');
    const fileId = idStr(info.fileId);
    const processed = new Promise<void>((resolve) => {
      const t = setTimeout(() => (this.attachWaiters.delete(fileId), resolve()), 60_000);
      this.attachWaiters.set(fileId, () => (clearTimeout(t), this.attachWaiters.delete(fileId), resolve()));
    });
    const res = await fetch(info.url, {
      method: 'POST',
      headers: {
        'content-type': file.mime || 'application/octet-stream',
        'content-disposition': `attachment; filename=${encodeURIComponent(file.name)}`,
        'content-range': `bytes 0-${data.length - 1}/${data.length}`,
      },
      body: data,
      signal: AbortSignal.timeout(300_000),
    });
    if (res.status !== 200 && res.status !== 201) throw new Error(`MAX не принял файл (${res.status})`);
    await processed;
    return { _type: 'FILE', fileId: info.fileId };
  }

  /** Сообщение по ID (команда 71). */
  private async message(wireId: string): Promise<{ chatId: bigint; m: MaxMessage }> {
    const id = parseWireId(wireId);
    if (!id) throw new Error('Сообщение не найдено');
    const r = await this.cmd<{ messages?: MaxMessage[] }>(OP.messages, { chatId: id.chatId, messageIds: [id.messageId] });
    const m = r.messages?.find((x) => idStr(x.id) === String(id.messageId));
    if (!m || m.status === 'REMOVED') throw new Error('Сообщение не найдено');
    return { chatId: id.chatId, m };
  }

  /** Изменить своё сообщение (срок задаёт MAX). */
  async edit(messageId: string, text: string): Promise<WireMessage> {
    this.ready();
    const id = parseWireId(messageId);
    if (!id) throw new Error('Сообщение не найдено');
    const r = await this.cmd<{ message: MaxMessage }>(OP.edit, { chatId: id.chatId, messageId: id.messageId, text, elements: [] }).catch((err: unknown) => {
      if (err instanceof MaxError) throw new Error(`MAX не дал изменить сообщение: ${err.message}`);
      throw err;
    });
    const wire = toWire(id.chatId, r.message, this.me, this.contacts);
    if (!wire?.fromMe) throw new Error('Изменить можно только своё сообщение');
    this.mem.bodyOf.set(wire.id, wire.body);
    return wire;
  }

  /** Удалить сообщение: `everyone` — у обоих собеседников, иначе только у себя. */
  async remove(messageId: string, everyone: boolean): Promise<void> {
    this.ready();
    const id = parseWireId(messageId);
    if (!id) throw new Error('Сообщение не найдено');
    await this.cmd(OP.remove, { chatId: id.chatId, messageIds: [id.messageId], forMe: !everyone });
  }

  /** Последние личные чаты и по `perChat` сообщений в каждом — загрузка истории в приложение. */
  async history(chats: number, perChat: number): Promise<WireMessage[]> {
    this.ready();
    const list = [...this.chats.values()]
      .filter((c) => c.type === 'DIALOG' && idStr(c.id) !== '0')
      .sort((a, b) => (b.lastEventTime ?? 0) - (a.lastEventTime ?? 0));
    await this.ensureContacts(list.map((c) => this.peerOf(c.id)));
    const out: WireMessage[] = [];
    for (const c of list.filter((x) => isClientContact(this.contacts.get(this.peerOf(x.id)))).slice(0, chats)) {
      const h = await this.cmd<{ messages?: MaxMessage[] }>(OP.history, { chatId: BigInt(idStr(c.id)), from: Date.now() + 60_000, forward: 0, backward: perChat, getMessages: true });
      for (const m of h.messages ?? []) {
        if (m.status === 'REMOVED') continue;
        const w = toWire(c.id, m, this.me, this.contacts);
        if (!w) continue;
        remember(this.mem, w, m.time);
        out.push(w);
      }
    }
    await this.save();
    return out;
  }

  /** Скачать вложение сообщения в хранилище (повтор — уже скачанное). */
  private async download(chatId: unknown, m: MaxMessage, w: WireMessage): Promise<WireMedia | null> {
    const have = await this.media.meta(this.spec.id, this.media.fileIdOf(this.spec.id, w.id));
    if (have) return have;
    if ((w.mediaInfo?.size ?? 0) > MAX_MEDIA_BYTES) return null;
    const a = mediaTypeOf(m.attaches)?.attach;
    if (!a) return null;
    const chat = BigInt(idStr(chatId));
    let url: string | undefined;
    if (a._type === 'PHOTO') url = a.baseUrl ?? a.url;
    else if (a._type === 'AUDIO') url = a.url;
    else if (a._type === 'FILE' && a.fileId != null) url = (await this.cmd<{ url: string }>(OP.fileDownload, { fileId: a.fileId, chatId: chat, messageId: BigInt(idStr(m.id)) })).url;
    else if (a._type === 'VIDEO' && a.videoId != null) {
      const v = await this.cmd<Record<string, string>>(OP.videoPlay, { videoId: a.videoId, token: a.token ?? '', chatId: chat, messageId: BigInt(idStr(m.id)) });
      url = v.MP4_720 ?? v.MP4_480 ?? v.MP4_1080 ?? v.MP4_360 ?? v.MP4_240 ?? v.MP4_144;
    }
    if (!url) return null;
    const got = await fetchLimited(url, MAX_MEDIA_BYTES);
    if (!got) return null;
    const mime = got.mime || w.mediaInfo?.mime || 'application/octet-stream';
    return this.media.save(this.spec.id, w.id, { mimetype: mime, data: got.data.toString('base64'), filename: w.mediaInfo?.name || defaultName(mime, w.type) });
  }

  /** Вложение по ID сообщения: из хранилища или скачать сейчас (история). */
  async mediaOf(messageId: string): Promise<WireMedia | null> {
    const have = await this.media.meta(this.spec.id, this.media.fileIdOf(this.spec.id, messageId));
    if (have) return have;
    this.ready();
    const { chatId, m } = await this.message(messageId);
    const w = toWire(chatId, m, this.me, this.contacts);
    if (!w?.hasMedia) return null;
    return this.download(chatId, m, w);
  }

  readMedia(fileId: string) {
    return this.media.read(this.spec.id, fileId);
  }

  /** Фото профиля собеседника — по ссылке из данных контакта (MAX доступен без прокси); нет — null. */
  async avatar(chatId: string): Promise<WireMedia | null> {
    const have = await this.media.recent(this.spec.id, avatarKey(chatId), AVATAR_TTL_MS);
    if (have) return have;
    const url = this.contacts.get(contactOfChat(chatId) ?? '')?.baseUrl;
    if (!url?.startsWith('https://')) return null;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (!res?.ok) return null;
    const data = Buffer.from(await res.arrayBuffer());
    if (!data.length || data.length > 5 * 1024 * 1024) return null;
    return this.media.save(this.spec.id, avatarKey(chatId), { mimetype: res.headers.get('content-type') || 'image/jpeg', data: data.toString('base64'), filename: 'avatar.jpg' });
  }

  /** Страница MAX — подставить файл в окно выбора файла (`screen-files.ts`). */
  filePage(): Page | null {
    return this.status.state === 'ready' ? this.page : null;
  }

  async screenshot(): Promise<Buffer | null> {
    if (!this.page) return null;
    return Buffer.from(await this.page.screenshot({ type: 'png' }));
  }
}

type LoginPayload = { profile?: { contact?: MaxContact }; chats?: MaxChat[]; contacts?: MaxContact[] };

/** Скачать по ссылке MAX не больше `max` байт; больше — null. */
async function fetchLimited(url: string, max: number): Promise<{ mime: string | null; data: Buffer } | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok || !res.body) throw new Error(`MAX: файл не скачался (${res.status})`);
  if (Number(res.headers.get('content-length') ?? 0) > max) return null;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += c.length;
    if (total > max) return null;
    chunks.push(Buffer.from(c));
  }
  return { mime: res.headers.get('content-type')?.split(';')[0] ?? null, data: Buffer.concat(chunks) };
}

