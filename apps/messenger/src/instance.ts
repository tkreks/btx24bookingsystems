import { cachedMediaFromBrowser } from './browser-media.js';
import { rm } from 'node:fs/promises';
import wwebjs from 'whatsapp-web.js';
import { ensureSerializedId, isClientChat, toWire, type WireEvent, type WireMessage } from './messages.js';
import { defaultName, MAX_MEDIA_BYTES, MediaStore, type WireMedia } from './media.js';
import { SCREEN, VirtualScreen } from './screen.js';
import type { InstanceSpec, InstanceState, InstanceStatus } from './spec.js';

const { Client, LocalAuth, MessageMedia } = wwebjs;

/** Вложение для отправки: base64, тип, имя. */
export interface OutgoingMedia {
  mime: string;
  name: string;
  data: string;
}

export interface InstanceConfig {
  dataDir: string;
  chromium: string;
  /** Запускать виртуальный экран и VNC (в контейнере — да; в тестах — нет). */
  display: boolean;
  /**
   * HTTP-прокси для мессенджеров (`http://host:port`, решение владельца 2026-10-24): с сервера WhatsApp
   * и Telegram напрямую недоступны. Пусто — напрямую.
   */
  proxy?: string;
}

export { SCREEN, vncPort } from './screen.js';

/**
 * Вход есть, а «готов» не наступил за это время — клиент перезапускается (сессия сохраняется).
 * whatsapp-web.js иногда зависает после входа на подключении слушателей страницы (экран WhatsApp
 * загружен, но событий и отправки нет).
 */
export const READY_TIMEOUT_MS = 90_000;
/** Перезапусков подряд без «готов», после которых — `failed` (не крутить бесконечно). */
const MAX_READY_RESTARTS = 3;

/**
 * Один мессенджер: виртуальный экран Xvfb `:N`, VNC к нему (только localhost — наружу отдаёт мост
 * через api), Chromium с WhatsApp Web (whatsapp-web.js), сессия — в `dataDir/sessions/<id>`
 * (переживает перезапуск: повторный вход не нужен).
 */
export class Instance {
  private readonly screen = new VirtualScreen();
  private client: InstanceType<typeof Client> | null = null;
  private status: InstanceStatus;
  private readonly media: MediaStore;
  private readyTimer: NodeJS.Timeout | null = null;
  private readyRestarts = 0;

  constructor(
    readonly spec: InstanceSpec,
    private readonly config: InstanceConfig,
    private readonly log: (msg: string) => void = (m) => console.log(m),
    /** События переписки → api (новые, правки, удаления, статусы). */
    private readonly emit: (e: WireEvent) => void = () => undefined,
  ) {
    this.media = new MediaStore(config.dataDir);
    this.status = { id: spec.id, kind: spec.kind, phone: spec.phone, auth: spec.auth, state: 'stopped', code: null, qr: null, account: null, error: null, updatedAt: new Date().toISOString() };
  }

  get info(): InstanceStatus {
    return this.status;
  }

  private set(state: InstanceState, patch: Partial<InstanceStatus> = {}) {
    this.status = { ...this.status, code: null, qr: null, ...patch, state, updatedAt: new Date().toISOString() };
    this.log(`[${this.spec.id}] ${state}${patch.error ? `: ${patch.error}` : ''}`);
  }

  async start(): Promise<void> {
    if (this.client) return;
    this.set('starting');
    try {
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (this.config.display) {
        await this.screen.start(this.spec.display);
        env.DISPLAY = `:${this.spec.display}`;
      }
      // Блокировка профиля от прежнего процесса (контейнер перезапущен) — иначе Chromium не стартует.
      for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie'])
        await rm(`${this.config.dataDir}/sessions/session-${this.spec.id}/${f}`, { force: true });
      const client = new Client({
        authStrategy: new LocalAuth({ clientId: this.spec.id, dataPath: `${this.config.dataDir}/sessions` }),
        ...(this.spec.auth === 'code' ? { pairWithPhoneNumber: { phoneNumber: this.spec.phone, showNotification: true, intervalMs: 180_000 } } : {}),
        // Кэш версии WhatsApp Web — в томе данных: рабочая папка образа только для чтения (без этого
        // запись падает молча, и после входа «готов» не наступает).
        webVersionCache: { type: 'local', path: `${this.config.dataDir}/wwebjs-cache` },
        deviceName: 'Приложение бронирования',
        browserName: 'Chrome',
        puppeteer: {
          executablePath: this.config.chromium,
          headless: !this.config.display,
          env,
          defaultViewport: null,
          args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--no-first-run',
            `--window-size=${SCREEN.width},${SCREEN.height}`,
            '--window-position=0,0',
            // Через прокси и имена хостов разрешает прокси (у сервера DNS к ним не отвечает).
            ...(this.config.proxy ? [`--proxy-server=${this.config.proxy}`] : []),
          ],
        },
      });
      client.on('code', (code: string) => this.set('pairing', { code }));
      client.on('qr', (qr: string) => this.set('qr', { qr }));
      client.on('authenticated', () => {
        this.set('authenticated');
        this.watchReady(client);
      });
      client.on('ready', () => {
        this.clearReadyTimer();
        this.readyRestarts = 0;
        this.set('ready', { account: client.info?.wid?._serialized ?? null });
      });
      // Переписка: и входящие, и отправленные (в том числе с телефона) — `message_create`.
      const id = this.spec.id;
      client.on('message_create', (m) => {
        const message = toWire(m as never);
        if (!message.id || !message.chatId) {
          this.log(`[${id}] message_create без ID: ключи id=${JSON.stringify(Object.keys(((m as { id?: object }).id ?? {}) as object))}`);
          return;
        }
        if (!isClientChat(message.chatId)) return;
        for (const w of this.waiters) w(message);
        // Вложение — скачать сразу (для открытой линии нужна ссылка на файл), потом отдать событие.
        void this.withPhone(message)
          .then(async (msg) => (msg.hasMedia ? { ...msg, media: await this.fetchMedia(m as never, msg).catch(() => null) } : msg))
          .then((msg) => this.emit({ type: 'message', instanceId: id, message: msg }));
      });
      client.on('message_edit', (m, body, prev) => {
        const w = toWire(m as never);
        this.emit({ type: 'edit', instanceId: id, id: w.id, chatId: w.chatId, body: String(body), prevBody: String(prev), at: Math.floor(Date.now() / 1000) });
      });
      client.on('message_revoke_everyone', (m, before) => {
        const w = toWire((before ?? m) as never);
        this.emit({ type: 'revoke', instanceId: id, id: w.id, chatId: w.chatId, at: Math.floor(Date.now() / 1000) });
      });
      client.on('message_ack', (m, ack) => this.emit({ type: 'ack', instanceId: id, id: toWire(m as never).id, ack: Number(ack) }));
      client.on('auth_failure', (msg: string) => this.set('failed', { error: `Вход не удался: ${msg}` }));
      client.on('disconnected', (reason: string) => {
        // LOGOUT — вход отозван в телефоне: сохранённая сессия больше не действует.
        this.set(String(reason).toUpperCase() === 'LOGOUT' ? 'logged_out' : 'disconnected', { error: String(reason) });
        void this.stopClient();
      });
      this.client = client;
      await client.initialize();
    } catch (err) {
      this.set('failed', { error: err instanceof Error ? err.message : String(err) });
      await this.stop(false);
    }
  }

  /** Остановить браузер и экран; `resetState: false` — не затирать итоговое состояние (logged_out, failed). */
  async stop(resetState = true): Promise<void> {
    await this.stopClient();
    this.screen.stop();
    if (resetState) this.set('stopped');
  }

  /** Выйти из аккаунта (сессия на телефоне удаляется) и остановиться. */
  async logout(): Promise<void> {
    await this.client?.logout().catch(() => undefined);
    await this.stop();
  }

  /** Ждут своё отправленное сообщение (`send`): библиотека не всегда возвращает его сама. */
  private readonly waiters = new Set<(m: WireMessage) => void>();
  /** Скрытый идентификатор `…@lid` → номер (WhatsApp знает его для контактов и тех, кому писали). */
  private readonly lidPhones = new Map<string, string | null>();

  private async withPhone(m: WireMessage): Promise<WireMessage> {
    if (!m.chatId.endsWith('@lid') || !this.client) return m;
    if (!this.lidPhones.has(m.chatId)) {
      const r = await this.client.getContactLidAndPhone([m.chatId]).catch(() => []);
      const pn = r[0]?.pn ? String(r[0].pn).replace(/@.*$/, '').replace(/\D/g, '') : '';
      this.lidPhones.set(m.chatId, pn || null);
    }
    return { ...m, phone: this.lidPhones.get(m.chatId) ?? null };
  }

  /** Скачать вложение сообщения в хранилище (повтор — уже скачанное). */
  private async fetchMedia(m: { downloadMedia: () => Promise<{ mimetype: string; data: string; filename?: string | null } | undefined> }, w: WireMessage): Promise<WireMedia | null> {
    const have = await this.media.meta(this.spec.id, this.media.fileIdOf(this.spec.id, w.id));
    if (have) return have;
    if ((w.mediaInfo?.size ?? 0) > MAX_MEDIA_BYTES) return null;
    ensureSerializedId(m as typeof m & { id?: Parameters<typeof ensureSerializedId>[0]['id'] });
    const page = this.client?.pupPage;
    const cached = () => page ? page.evaluate(cachedMediaFromBrowser, w.id, MAX_MEDIA_BYTES) : Promise.resolve(null);
    let media = await cached();
    if (!media) {
      try { media = await m.downloadMedia() ?? null; }
      catch (err) {
        // В новых WA повторное downloadAndMaybeDecrypt библиотеки теряет MIME; готовый Blob уже есть.
        media = await cached(); if (!media) throw err;
      }
    }
    if (!media?.data) return null;
    return this.media.save(this.spec.id, w.id, { ...media, filename: media.filename || defaultName(media.mimetype, w.type) });
  }

  /** Вложение по ID сообщения: из хранилища или скачать сейчас (история). */
  async mediaOf(messageId: string): Promise<WireMedia | null> {
    const have = await this.media.meta(this.spec.id, this.media.fileIdOf(this.spec.id, messageId));
    if (have) return have;
    const m = await this.ready().getMessageById(messageId);
    if (!m?.hasMedia) return null;
    return this.fetchMedia(m as never, toWire(m as never));
  }

  readMedia(fileId: string) {
    return this.media.read(this.spec.id, fileId);
  }

  private ready() {
    if (!this.client || this.status.state !== 'ready') throw new Error('Мессенджер не подключён');
    return this.client;
  }

  /** Проверка регистрации — без отправки сообщения и создания диалога. */
  async contact(phone: string): Promise<{ exists: boolean; chatId: string | null }> {
    const digits = phone.replace(/\D/g, '');
    if (!/^\d{11,15}$/.test(digits)) throw new Error('Некорректный номер');
    const wid = await this.ready().getNumberId(digits);
    return { exists: !!wid, chatId: wid ? `${digits}@c.us` : null };
  }

  /** Чат по номеру телефона (проверяем, что номер есть в WhatsApp) или ID чата как есть. */
  async resolveChat(to: string): Promise<string> {
    if (to.includes('@')) return to;
    const digits = to.replace(/\D/g, '');
    const wid = await this.ready().getNumberId(digits);
    if (!wid) throw new Error(`Номера +${digits} нет в WhatsApp`);
    // Чат по номеру (`…@c.us`): по скрытому ID (`…@lid`) библиотека отправляет не всегда.
    return `${digits}@c.us`;
  }

  /**
   * Отправить. Новые версии WhatsApp Web адресуют чат скрытым ID (`…@lid`), и библиотека, отправив,
   * может не найти своё сообщение и вернуть пусто — тогда берём его из события `message_create`.
   */
  async send(to: string, text: string, quotedId?: string, file?: OutgoingMedia): Promise<WireMessage> {
    if (file && (file.data.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4 || Buffer.byteLength(file.data, 'base64') > MAX_MEDIA_BYTES)) throw new Error('Файл больше 64 МБ');
    const client = this.ready();
    const chatId = await this.resolveChat(to);
    const phone = /^(\d{10,15})@c\.us$/.exec(chatId)?.[1] ?? (to.includes('@') ? null : to.replace(/\D/g, ''));
    let resolve: (m: WireMessage) => void = () => undefined;
    const echo = new Promise<WireMessage>((r) => (resolve = r));
    const waiter = (m: WireMessage) => m.fromMe && m.body === text && m.hasMedia === !!file && resolve(m);
    this.waiters.add(waiter);
    try {
      const kind = file?.mime.split('/')[0];
      const sent = file
        ? await client.sendMessage(chatId, new MessageMedia(file.mime, file.data, file.name), {
            caption: text || undefined,
            // Фото, видео и аудио — как медиа; остальное — документом (с именем файла).
            sendMediaAsDocument: kind !== 'image' && kind !== 'video' && kind !== 'audio',
            ...(quotedId ? { quotedMessageId: quotedId } : {}),
          })
        : await client.sendMessage(chatId, text, quotedId ? { quotedMessageId: quotedId } : undefined);
      const wire = sent ? toWire(sent as never) : null;
      const m = wire?.id ? wire : await Promise.race([echo, new Promise<null>((r) => setTimeout(() => r(null), 15_000))]);
      if (!m) throw new Error('Сообщение отправлено, но WhatsApp не подтвердил его за 15 секунд — проверьте в чате');
      if (phone && m.chatId.endsWith('@lid')) this.lidPhones.set(m.chatId, phone);
      // Своё вложение — сразу в хранилище (данные уже есть, качать не нужно).
      const media = file ? await this.media.save(this.spec.id, m.id, { mimetype: file.mime, data: file.data, filename: file.name }) : null;
      return { ...m, ...(media ? { media, hasMedia: true } : {}), phone: phone ?? this.lidPhones.get(m.chatId) ?? null };
    } finally {
      this.waiters.delete(waiter);
    }
  }

  /** Изменить своё сообщение (WhatsApp разрешает в течение 15 минут). */
  async edit(messageId: string, text: string): Promise<WireMessage> {
    const m = await this.ready().getMessageById(messageId);
    if (!m) throw new Error('Сообщение не найдено');
    ensureSerializedId(m);
    const edited = await m.edit(text);
    if (!edited) throw new Error('WhatsApp не дал изменить сообщение (прошло больше 15 минут или оно чужое)');
    return toWire(edited as never);
  }

  /** Удалить сообщение: `everyone` — у всех (своё), иначе только у себя. */
  async remove(messageId: string, everyone: boolean): Promise<void> {
    const m = await this.ready().getMessageById(messageId);
    if (!m) throw new Error('Сообщение не найдено');
    ensureSerializedId(m);
    await m.delete(everyone);
  }

  /** Последние чаты с клиентами и по `perChat` сообщений в каждом — загрузка истории в приложение. */
  async history(chats: number, perChat: number): Promise<WireMessage[]> {
    const list = (await this.ready().getChats()).filter((c) => isClientChat(c.id._serialized)).slice(0, chats);
    const out: WireMessage[] = [];
    for (const c of list) for (const m of await c.fetchMessages({ limit: perChat })) out.push(toWire(m as never));
    return out;
  }

  /** Снимок экрана страницы WhatsApp Web (PNG) — когда VNC недоступен. */
  async screenshot(): Promise<Buffer | null> {
    const page = this.client?.pupPage;
    if (!page) return null;
    return Buffer.from(await page.screenshot({ type: 'png' }));
  }

  /** Сторож «готов» после входа: см. `READY_TIMEOUT_MS`. */
  private watchReady(client: InstanceType<typeof Client>) {
    this.clearReadyTimer();
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      if (this.client !== client || this.status.state !== 'authenticated') return;
      if (++this.readyRestarts > MAX_READY_RESTARTS) {
        this.readyRestarts = 0;
        this.set('failed', { error: 'WhatsApp Web не перешёл в «готов» после входа' });
        void this.stop(false);
        return;
      }
      this.log(`[${this.spec.id}] нет «готов» ${READY_TIMEOUT_MS / 1000} с после входа — перезапуск (${this.readyRestarts}/${MAX_READY_RESTARTS})`);
      void this.stopClient().then(() => this.start());
    }, READY_TIMEOUT_MS);
    this.readyTimer.unref?.();
  }

  private clearReadyTimer() {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }

  private async stopClient(): Promise<void> {
    this.clearReadyTimer();
    const client = this.client;
    this.client = null;
    await client?.destroy().catch(() => undefined);
  }
}

/** Что сервис умеет с экземпляром любого мессенджера (WhatsApp — `Instance`, Telegram — `TelegramInstance`). */
export type MessengerInstance = Pick<Instance, 'spec' | 'info' | 'start' | 'stop' | 'logout' | 'contact' | 'send' | 'edit' | 'remove' | 'history' | 'screenshot' | 'mediaOf' | 'readMedia'>;
