import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import type { InstanceConfig, OutgoingMedia } from './instance.js';
import type { WireEvent, WireMessage } from './messages.js';
import { defaultName, MAX_MEDIA_BYTES, MediaStore, type WireMedia } from './media.js';
import { SCREEN, VirtualScreen } from './screen.js';
import type { InstanceSpec, InstanceState, InstanceStatus } from './spec.js';
import { eventsOf, isClientUser, msgIdOf, newMemory, toWire, userIdOfChat, type TgMessage, type TgUpdate, type TgUser } from './telegram-wire.js';

export const TELEGRAM_URL = 'https://web.telegram.org/k/';
/** Как часто проверять вход и забирать изменения, если Telegram Web сам не дал знать. */
const POLL_MS = 10_000;

type Peer = { _: 'inputPeerUser'; user_id: string; access_hash: string } | { _: 'inputPeerChat'; chat_id: string };
interface SavedState {
  pts: number;
  date: number;
  qts: number;
  users: Record<string, { id: string; access_hash: string; phone?: string; first_name?: string; last_name?: string; username?: string; bot?: boolean }>;
}

/** Ошибка Telegram API из страницы: `{ error: 'AUTH_KEY_UNREGISTERED' }`. */
class TgError extends Error {}

/**
 * Telegram (ADR 0014): тот же подход, что у WhatsApp, — виртуальный экран Xvfb `:N`, VNC к нему и
 * Chromium с Telegram Web K; профиль браузера (вход) — `dataDir/sessions/session-<id>`. Готовой
 * библиотеки вроде whatsapp-web.js нет, поэтому разметку страницы не разбираем: вызываем Telegram API
 * (MTProto) через клиент самой страницы — `rootScope.managers.apiManager.invokeApi`. Вход — на экране
 * (QR или номер и код, 2FA-пароль), изменения — `updates.getDifference` со своим `pts` в
 * `dataDir/telegram-<id>.json` (после перезапуска сервиса дочитываем пропущенное).
 */
export class TelegramInstance {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private status: InstanceStatus;
  private readonly media: MediaStore;
  private readonly screen = new VirtualScreen();
  private timer: NodeJS.Timeout | null = null;
  private pulling: Promise<void> | null = null;
  private again = false;
  private state: SavedState | null = null;
  private readonly users = new Map<string, TgUser>();
  private readonly mem = newMemory();
  private wasReady = false;

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
    this.log(`[${this.spec.id}] telegram ${state}${patch.error ? `: ${patch.error}` : ''}`);
  }

  private get profile() {
    return `${this.config.dataDir}/sessions/session-${this.spec.id}`;
  }
  private get stateFile() {
    return `${this.config.dataDir}/telegram-${this.spec.id}.json`;
  }

  async start(): Promise<void> {
    if (this.browser) return;
    this.set('starting');
    try {
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (this.config.display) {
        await this.screen.start(this.spec.display);
        env.DISPLAY = `:${this.spec.display}`;
      }
      await mkdir(this.profile, { recursive: true });
      // Блокировка профиля от прежнего процесса (контейнер перезапущен) — иначе Chromium не стартует.
      for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) await rm(`${this.profile}/${f}`, { force: true });
      this.state = await readFile(this.stateFile, 'utf8').then((s) => JSON.parse(s) as SavedState, () => null);
      for (const u of Object.values(this.state?.users ?? {}))
        this.users.set(u.id, { _: 'user', id: u.id, access_hash: u.access_hash, phone: u.phone, first_name: u.first_name, last_name: u.last_name, username: u.username, pFlags: u.bot ? { bot: true } : {} });
      const browser = await puppeteer.launch({
        executablePath: this.config.chromium,
        headless: !this.config.display,
        userDataDir: this.profile,
        env,
        defaultViewport: null,
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--no-first-run',
          `--window-size=${SCREEN.width},${SCREEN.height}`,
          '--window-position=0,0',
          // Через прокси и имена хостов разрешает прокси (у сервера DNS к Telegram не отвечает).
          ...(this.config.proxy ? [`--proxy-server=${this.config.proxy}`] : []),
        ],
      });
      this.browser = browser;
      browser.on('disconnected', () => {
        if (this.browser !== browser) return;
        this.browser = this.page = null;
        this.stopTimer();
        this.set('disconnected', { error: 'Браузер Telegram закрылся' });
      });
      const page = (await browser.pages())[0] ?? (await browser.newPage());
      this.page = page;
      // Telegram Web сообщает о любом изменении переписки — забираем изменения сразу, не ждём опроса.
      await page.exposeFunction('__btxNotify', () => this.pull());
      await page.goto(TELEGRAM_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      this.timer = setInterval(() => void this.tick(), POLL_MS);
      void this.tick();
    } catch (err) {
      this.set('failed', { error: err instanceof Error ? err.message : String(err) });
      await this.stop(false);
    }
  }

  /** Остановить браузер и экран; `resetState: false` — не затирать итоговое состояние (logged_out, failed). */
  async stop(resetState = true): Promise<void> {
    this.stopTimer();
    const browser = this.browser;
    this.browser = this.page = null;
    await browser?.close().catch(() => undefined);
    this.screen.stop();
    this.wasReady = false;
    if (resetState) this.set('stopped');
  }

  /** Выйти из аккаунта (сеанс в «Настройки → Устройства» завершается) и остановиться. */
  async logout(): Promise<void> {
    if (this.status.state === 'ready') await this.invoke('auth.logOut', {}).catch(() => undefined);
    await this.stop();
    await rm(this.stateFile, { force: true });
  }

  private stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Вызов Telegram API клиентом страницы. Ошибка Telegram — `TgError` с её кодом (`PEER_ID_INVALID`…). */
  private async invoke<T>(method: string, params: object, options: object = {}): Promise<T> {
    const page = this.page;
    if (!page) throw new Error('Мессенджер не подключён');
    const r = await page.evaluate(
      async (m, p, o) => {
        const api = (window as unknown as { rootScope?: { managers?: { apiManager?: { invokeApi: (m: string, p: object, o: object) => Promise<unknown> } } } }).rootScope?.managers?.apiManager;
        if (!api) return { error: 'NOT_LOADED' };
        try {
          return { result: await api.invokeApi(m, p, o) };
        } catch (e) {
          const x = e as { type?: string; message?: string };
          return { error: String(x?.type ?? x?.message ?? e) };
        }
      },
      method,
      params as never,
      options as never,
    );
    if ('error' in r) throw new TgError(r.error);
    return r.result as T;
  }

  /** Подписка на события страницы (после перезагрузки Telegram Web — заново). */
  private async hook(): Promise<void> {
    await this.page?.evaluate(() => {
      const w = window as unknown as { rootScope?: Record<string, unknown> & { __btx?: boolean }; __btxNotify?: () => void };
      const rs = w.rootScope;
      if (!rs || rs.__btx) return;
      rs.__btx = true;
      for (const name of ['dispatchEvent', 'dispatchEventSingle'] as const) {
        const orig = rs[name] as ((n: string, ...a: unknown[]) => unknown) | undefined;
        if (typeof orig !== 'function') continue;
        let t: ReturnType<typeof setTimeout> | null = null;
        rs[name] = function (this: unknown, n: string, ...a: unknown[]) {
          if (/^(history_|message_|dialog)/.test(String(n)) && !t) t = setTimeout(() => ((t = null), w.__btxNotify?.()), 700);
          return orig.call(this, n, ...a);
        };
      }
    });
  }

  /** Вход проверяется раз в `POLL_MS`: пока не вошли — состояние «вход на экране» (`qr`). */
  private async tick(): Promise<void> {
    if (!this.page) return;
    try {
      await this.invoke('updates.getState', {});
    } catch (err) {
      const code = err instanceof TgError ? err.message : '';
      if (code === 'NOT_LOADED') return;
      if (code === 'AUTH_KEY_UNREGISTERED' || code === 'SESSION_REVOKED' || code === 'AUTH_KEY_INVALID') {
        // Был вход и пропал — сеанс завершён в телефоне. Экран остаётся: можно войти снова.
        if (this.wasReady) {
          this.wasReady = false;
          this.state = null;
          await rm(this.stateFile, { force: true });
          this.set('logged_out', { error: 'Сеанс завершён в Telegram — войдите заново на экране' });
        } else if (this.status.state !== 'logged_out') this.set('qr');
        return;
      }
      this.log(`[${this.spec.id}] telegram: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!this.wasReady) {
      this.set('authenticated');
      const [me] = await this.invoke<TgUser[]>('users.getUsers', { id: [{ _: 'inputUserSelf' }] });
      const phone = me?.phone?.replace(/\D/g, '') ?? '';
      if (!this.state) {
        const s = await this.invoke<{ pts: number; date: number; qts: number }>('updates.getState', {});
        this.state = { pts: s.pts, date: s.date, qts: s.qts, users: {} };
        await this.save();
      }
      this.wasReady = true;
      this.set('ready', {
        account: phone ? `${phone}@c.us` : null,
        error: phone && phone !== this.spec.phone ? `Вход выполнен с другим номером: +${phone}` : null,
      });
    }
    await this.hook().catch(() => undefined);
    await this.pull();
  }

  /** Забрать изменения с прошлого раза (повторный вызов во время работы — ещё один проход после). */
  private pull(): Promise<void> {
    if (!this.wasReady) return Promise.resolve();
    if (this.pulling) {
      this.again = true;
      return this.pulling;
    }
    this.pulling = (async () => {
      do {
        this.again = false;
        await this.difference().catch((err: unknown) => this.log(`[${this.spec.id}] telegram getDifference: ${err instanceof Error ? err.message : String(err)}`));
      } while (this.again);
    })().finally(() => (this.pulling = null));
    return this.pulling;
  }

  private async difference(): Promise<void> {
    for (let i = 0; i < 20 && this.state; i++) {
      type Diff = { _: string; pts?: number; date?: number; seq?: number; new_messages?: TgMessage[]; other_updates?: TgUpdate[]; users?: TgUser[]; state?: SavedState; intermediate_state?: SavedState };
      const d = await this.invoke<Diff>('updates.getDifference', { pts: this.state.pts, date: this.state.date, qts: this.state.qts });
      if (d._ === 'updates.differenceEmpty') {
        this.state.date = d.date ?? this.state.date;
        return;
      }
      if (d._ === 'updates.differenceTooLong') {
        // Пропущено слишком много (сервис долго стоял) — дальше с текущего места; старое — «Загрузить историю».
        this.state.pts = d.pts ?? this.state.pts;
        await this.save();
        continue;
      }
      this.learn(d.users ?? []);
      const { events, messages } = eventsOf(this.spec.id, d.new_messages ?? [], d.other_updates ?? [], this.users, this.mem);
      for (const { wire, raw } of messages) await this.deliver(wire, raw);
      for (const e of events) this.emit(e);
      const next = d._ === 'updates.differenceSlice' ? d.intermediate_state : d.state;
      if (next) Object.assign(this.state, { pts: next.pts, date: next.date, qts: next.qts });
      await this.save();
      if (d._ !== 'updates.differenceSlice') return;
    }
  }

  /** Новое сообщение → api; вложение скачивается сразу (для открытой линии нужна ссылка на файл). */
  private async deliver(wire: WireMessage, raw: TgMessage): Promise<void> {
    const media = wire.hasMedia ? await this.download(raw.id, wire).catch(() => null) : null;
    this.emit({ type: 'message', instanceId: this.spec.id, message: media ? { ...wire, media } : wire });
  }

  /** Пользователи из ответов Telegram — для `access_hash` (без него не написать) и номера. */
  private learn(users: TgUser[]) {
    let changed = false;
    for (const u of users) {
      if (u._ !== 'user') continue;
      const id = String(u.id);
      const prev = this.users.get(id);
      // «min»-объекты приходят без access_hash — не затираем известный.
      const merged = { ...prev, ...u, id, access_hash: u.access_hash != null ? String(u.access_hash) : prev?.access_hash };
      this.users.set(id, merged);
      if (this.state && merged.access_hash && isClientUser(merged)) {
        const s = this.state.users[id];
        const next = { id, access_hash: String(merged.access_hash), phone: merged.phone, first_name: merged.first_name, last_name: merged.last_name, username: merged.username, bot: !!merged.pFlags?.bot };
        if (!s || s.access_hash !== next.access_hash || s.phone !== next.phone) {
          this.state.users[id] = next;
          changed = true;
        }
      }
    }
    return changed;
  }

  private async save(): Promise<void> {
    if (this.state) await writeFile(this.stateFile, JSON.stringify(this.state));
  }

  private ready() {
    if (!this.page || this.status.state !== 'ready') throw new Error('Мессенджер не подключён');
  }

  /** Пользователь по номеру: известный, поиск по номеру, иначе — добавить номер в контакты аккаунта. */
  private async userByPhone(phone: string, importContact: boolean): Promise<TgUser | null> {
    const known = [...this.users.values()].find((u) => u.phone && u.phone.replace(/\D/g, '') === phone && u.access_hash);
    if (known) return known;
    const r = await this.invoke<{ users: TgUser[] }>('contacts.resolvePhone', { phone }).catch(() => null);
    if (r?.users?.length) {
      this.learn(r.users);
      await this.save();
      return this.users.get(String(r.users[0].id)) ?? null;
    }
    if (!importContact) return null;
    // Номер скрыт настройками приватности — так его находят и приложения Telegram: через контакты.
    const imp = await this.invoke<{ users: TgUser[] }>('contacts.importContacts', { contacts: [{ _: 'inputPhoneContact', client_id: randomLong(), phone, first_name: `+${phone}`, last_name: '' }] });
    if (!imp.users?.length) return null;
    this.learn(imp.users);
    await this.save();
    return this.users.get(String(imp.users[0].id)) ?? null;
  }

  /** Проверка регистрации — без отправки сообщения. Скрытый настройками номер добавляется в контакты. */
  async contact(phone: string): Promise<{ exists: boolean; chatId: string | null }> {
    const digits = phone.replace(/\D/g, '');
    if (!/^\d{11,15}$/.test(digits)) throw new Error('Некорректный номер');
    this.ready();
    const u = await this.userByPhone(digits, true);
    return { exists: !!u, chatId: u ? `${u.id}@lid` : null };
  }

  /** Куда писать: `<номер>@c.us` (найти по номеру), `<userId>@lid` (известный собеседник), `<chatId>@g.us`. */
  private async peerOf(to: string): Promise<{ peer: Peer; chatId: string; user: TgUser | null }> {
    const group = /^(\d{1,20})@g\.us$/.exec(to)?.[1];
    if (group) return { peer: { _: 'inputPeerChat', chat_id: group }, chatId: to, user: null };
    const uid = userIdOfChat(to);
    let user = uid ? this.users.get(uid) : null;
    if (!uid) {
      const digits = to.replace(/@.*$/, '').replace(/\D/g, '');
      if (!/^\d{10,15}$/.test(digits)) throw new Error('Некорректный получатель');
      user = await this.userByPhone(digits, true);
      if (!user) throw new Error(`Номера +${digits} нет в Telegram`);
    }
    if (!user?.access_hash) throw new Error('Собеседник Telegram неизвестен — загрузите историю или напишите по номеру');
    return { peer: { _: 'inputPeerUser', user_id: String(user.id), access_hash: String(user.access_hash) }, chatId: `${user.id}@lid`, user };
  }

  async send(to: string, text: string, quotedId?: string, file?: OutgoingMedia): Promise<WireMessage> {
    if (file && (file.data.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4 || Buffer.byteLength(file.data, 'base64') > MAX_MEDIA_BYTES)) throw new Error('Файл больше 64 МБ');
    this.ready();
    const { peer, chatId, user } = await this.peerOf(to);
    const replyId = quotedId ? msgIdOf(quotedId) : null;
    const reply = replyId ? { reply_to: { _: 'inputReplyToMessage', reply_to_msg_id: replyId } } : {};
    let updates: SentUpdates;
    if (file) {
      const input = await this.upload(file);
      const kind = file.mime.split('/')[0];
      const photo = kind === 'image' && /^image\/(jpeg|png|webp)$/.test(file.mime);
      const media = photo
        ? { _: 'inputMediaUploadedPhoto', file: input }
        : { _: 'inputMediaUploadedDocument', file: input, mime_type: file.mime, attributes: [{ _: 'documentAttributeFilename', file_name: file.name }] };
      updates = await this.invoke('messages.sendMedia', { peer, media, message: text, random_id: randomLong(), ...reply });
    } else updates = await this.invoke('messages.sendMessage', { peer, message: text, random_id: randomLong(), ...reply });
    const now = Math.floor(Date.now() / 1000);
    const created = sentMessage(updates);
    this.learn(updates.users ?? []);
    let wire: WireMessage | null = created ? toWire(created, this.users) : null;
    if (!wire) {
      const id = updates._ === 'updateShortSentMessage' ? updates.id : updates.updates?.find((u) => u._ === 'updateMessageID')?.id;
      if (!id) throw new Error('Сообщение отправлено, но Telegram не вернул его номер — проверьте в чате');
      wire = { id: `tg_${id}`, chatId, fromMe: true, author: null, name: null, body: text, type: 'chat', hasMedia: false, mediaInfo: null, quotedId: quotedId ?? null, timestamp: updates.date ?? now, ack: 1 };
    }
    const msgId = msgIdOf(wire.id)!;
    this.mem.chatOf.set(msgId, wire.chatId);
    this.mem.bodyOf.set(msgId, wire.body);
    const set = this.mem.unread.get(wire.chatId) ?? new Set<number>();
    this.mem.unread.set(wire.chatId, set.add(msgId));
    // Своё вложение — сразу в хранилище (данные уже есть, качать не нужно).
    const saved = file ? await this.media.save(this.spec.id, wire.id, { mimetype: file.mime, data: file.data, filename: file.name }) : null;
    return { ...wire, ...(saved ? { media: saved, hasMedia: true } : {}), phone: user?.phone?.replace(/\D/g, '') || (to.endsWith('@c.us') ? to.replace(/@.*$/, '') : null) };
  }

  /** Файл в Telegram частями по 512 КБ (больше 10 МБ — «большой файл»). */
  private async upload(file: OutgoingMedia): Promise<object> {
    const page = this.page!;
    const size = Buffer.byteLength(file.data, 'base64');
    const id = randomLong();
    const r = await page.evaluate(
      async (b64, fileId, name, total) => {
        const api = (window as unknown as { rootScope: { managers: { apiManager: { invokeApi: (m: string, p: object, o: object) => Promise<unknown> } } } }).rootScope.managers.apiManager;
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const part = 512 * 1024;
        const parts = Math.max(1, Math.ceil(total / part));
        const big = total > 10 * 1024 * 1024;
        try {
          for (let i = 0; i < parts; i++) {
            const chunk = bytes.slice(i * part, (i + 1) * part);
            await api.invokeApi(big ? 'upload.saveBigFilePart' : 'upload.saveFilePart', big ? { file_id: fileId, file_part: i, file_total_parts: parts, bytes: chunk } : { file_id: fileId, file_part: i, bytes: chunk }, { fileUpload: true });
          }
        } catch (e) {
          return { error: String((e as { type?: string })?.type ?? e) };
        }
        return { file: { _: big ? 'inputFileBig' : 'inputFile', id: fileId, parts, name, ...(big ? {} : { md5_checksum: '' }) } };
      },
      file.data,
      id,
      file.name,
      size,
    );
    if ('error' in r) throw new TgError(`Не удалось загрузить файл в Telegram: ${r.error}`);
    return r.file;
  }

  /** Сообщение по номеру (в личных чатах номер уникален на аккаунт). */
  private async message(wireId: string): Promise<TgMessage> {
    const id = msgIdOf(wireId);
    if (!id) throw new Error('Сообщение не найдено');
    const r = await this.invoke<{ messages: TgMessage[]; users?: TgUser[] }>('messages.getMessages', { id: [{ _: 'inputMessageID', id }] });
    this.learn(r.users ?? []);
    const m = r.messages?.[0];
    if (!m || m._ !== 'message') throw new Error('Сообщение не найдено');
    return m;
  }

  /** Изменить своё сообщение (Telegram разрешает в течение 48 часов). */
  async edit(messageId: string, text: string): Promise<WireMessage> {
    this.ready();
    const m = await this.message(messageId);
    const chatId = toWire(m, this.users)?.chatId;
    if (!chatId || !m.pFlags?.out) throw new Error('Изменить можно только своё сообщение');
    const { peer } = await this.peerOf(chatId);
    const r = await this.invoke<SentUpdates>('messages.editMessage', { peer, id: m.id, message: text }).catch((err: unknown) => {
      if (err instanceof TgError && err.message === 'MESSAGE_EDIT_TIME_EXPIRED') throw new Error('Telegram не дал изменить сообщение: прошло больше 48 часов');
      throw err;
    });
    const edited = r.updates?.find((u) => u._ === 'updateEditMessage')?.message as TgMessage | undefined;
    const wire = toWire(edited ?? { ...m, message: text }, this.users)!;
    this.mem.bodyOf.set(m.id, wire.body);
    return wire;
  }

  /** Удалить сообщение: `everyone` — у обоих собеседников, иначе только у себя. */
  async remove(messageId: string, everyone: boolean): Promise<void> {
    this.ready();
    const id = msgIdOf(messageId);
    if (!id) throw new Error('Сообщение не найдено');
    await this.invoke('messages.deleteMessages', { id: [id], pFlags: everyone ? { revoke: true } : {} });
  }

  /** Последние личные чаты и по `perChat` сообщений в каждом — загрузка истории в приложение. */
  async history(chats: number, perChat: number): Promise<WireMessage[]> {
    this.ready();
    const d = await this.invoke<{ dialogs: { peer: { _: string; user_id?: string | number } }[]; users?: TgUser[] }>('messages.getDialogs', {
      offset_date: 0,
      offset_id: 0,
      offset_peer: { _: 'inputPeerEmpty' },
      limit: Math.min(100, chats * 2),
      hash: '0',
    });
    this.learn(d.users ?? []);
    const peers = d.dialogs
      .filter((x) => x.peer._ === 'peerUser' && isClientUser(this.users.get(String(x.peer.user_id))))
      .slice(0, chats)
      .map((x) => `${x.peer.user_id}@lid`);
    const out: WireMessage[] = [];
    for (const chatId of peers) {
      const { peer } = await this.peerOf(chatId);
      const h = await this.invoke<{ messages: TgMessage[]; users?: TgUser[] }>('messages.getHistory', { peer, offset_id: 0, offset_date: 0, add_offset: 0, limit: perChat, max_id: 0, min_id: 0, hash: '0' });
      this.learn(h.users ?? []);
      for (const m of h.messages) {
        const w = toWire(m, this.users);
        if (!w) continue;
        this.mem.chatOf.set(m.id, w.chatId);
        this.mem.bodyOf.set(m.id, w.body);
        out.push(w);
      }
    }
    await this.save();
    return out;
  }

  /** Скачать вложение сообщения в хранилище (повтор — уже скачанное). */
  private async download(msgId: number, w: WireMessage): Promise<WireMedia | null> {
    const have = await this.media.meta(this.spec.id, this.media.fileIdOf(this.spec.id, w.id));
    if (have) return have;
    if ((w.mediaInfo?.size ?? 0) > MAX_MEDIA_BYTES) return null;
    const r = await this.page!.evaluate(
      async (id, max) => {
        type Size = { _: string; type: string; size?: number; sizes?: number[] };
        const api = (window as unknown as { rootScope: { managers: { apiManager: { invokeApi: (m: string, p: object, o?: object) => Promise<unknown> } } } }).rootScope.managers.apiManager;
        try {
          // Свежий объект: у ссылки на файл (`file_reference`) ограниченный срок.
          const got = (await api.invokeApi('messages.getMessages', { id: [{ _: 'inputMessageID', id }] })) as { messages: { media?: { photo?: { id: string; access_hash: string; file_reference: Uint8Array; dc_id: number; sizes: Size[] }; document?: { id: string; access_hash: string; file_reference: Uint8Array; dc_id: number; size: number; mime_type: string } } }[] };
          const media = got.messages[0]?.media;
          let location: object;
          let dcId: number;
          let size: number;
          let mime: string;
          if (media?.photo) {
            const best = media.photo.sizes
              .map((s) => ({ s, n: s.size ?? s.sizes?.[s.sizes.length - 1] ?? 0 }))
              .filter((x) => x.n > 0)
              .sort((a, b) => b.n - a.n)[0];
            if (!best) return { none: true };
            location = { _: 'inputPhotoFileLocation', id: media.photo.id, access_hash: media.photo.access_hash, file_reference: media.photo.file_reference, thumb_size: best.s.type };
            dcId = media.photo.dc_id;
            size = best.n;
            mime = 'image/jpeg';
          } else if (media?.document) {
            const d = media.document;
            location = { _: 'inputDocumentFileLocation', id: d.id, access_hash: d.access_hash, file_reference: d.file_reference, thumb_size: '' };
            dcId = d.dc_id;
            size = Number(d.size);
            mime = d.mime_type || 'application/octet-stream';
          } else return { none: true };
          if (size > max) return { none: true };
          const limit = 512 * 1024;
          const chunks: Uint8Array[] = [];
          for (let offset = 0; ; offset += limit) {
            const part = (await api.invokeApi('upload.getFile', { location, offset, limit }, { dcId, fileDownload: true })) as { bytes: Uint8Array };
            chunks.push(part.bytes);
            if (part.bytes.length < limit || offset + limit >= size) break;
          }
          let bin = '';
          for (const c of chunks) for (let i = 0; i < c.length; i += 0x8000) bin += String.fromCharCode(...c.subarray(i, i + 0x8000));
          return { mimetype: mime, data: btoa(bin) };
        } catch (e) {
          return { error: String((e as { type?: string })?.type ?? e) };
        }
      },
      msgId,
      MAX_MEDIA_BYTES,
    );
    if ('error' in r) throw new TgError(r.error);
    if ('none' in r) return null;
    return this.media.save(this.spec.id, w.id, { mimetype: r.mimetype, data: r.data, filename: w.mediaInfo?.name || defaultName(r.mimetype, w.type) });
  }

  /** Вложение по ID сообщения: из хранилища или скачать сейчас (история). */
  async mediaOf(messageId: string): Promise<WireMedia | null> {
    const have = await this.media.meta(this.spec.id, this.media.fileIdOf(this.spec.id, messageId));
    if (have) return have;
    this.ready();
    const m = await this.message(messageId);
    const w = toWire(m, this.users);
    if (!w?.hasMedia) return null;
    return this.download(m.id, w);
  }

  readMedia(fileId: string) {
    return this.media.read(this.spec.id, fileId);
  }

  /** Страница Telegram Web — подставить файл в окно выбора файла (`screen-files.ts`). */
  filePage(): Page | null {
    return this.status.state === 'ready' ? this.page : null;
  }

  /** Снимок экрана Telegram Web (PNG) — когда VNC недоступен. */
  async screenshot(): Promise<Buffer | null> {
    if (!this.page) return null;
    return Buffer.from(await this.page.screenshot({ type: 'png' }));
  }
}

type SentUpdates = {
  _: string;
  id?: number;
  date?: number;
  users?: TgUser[];
  updates?: { _: string; id?: number; message?: TgMessage }[];
};

/** Созданное сообщение из ответа на отправку (`updates` с `updateNewMessage`). */
function sentMessage(u: SentUpdates): TgMessage | null {
  return (u.updates?.find((x) => x._ === 'updateNewMessage')?.message as TgMessage | undefined) ?? null;
}

/** Случайный положительный 63-битный long строкой (так длинные числа передаёт Telegram Web). */
export function randomLong(): string {
  return (randomBytes(8).readBigUInt64BE() >> 1n).toString();
}
