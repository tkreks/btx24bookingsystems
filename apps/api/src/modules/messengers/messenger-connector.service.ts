import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import type { Messenger, MessengerMessage, Portal } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { B24_CONFIG, type Bitrix24Config } from '../bitrix24/bitrix24.tokens.js';
import { onBitrixEvent } from '../bitrix24/events/events.service.js';
import { PortalService } from '../bitrix24/portals/portal.service.js';
import { Bitrix24Error } from '../bitrix24/rest/errors.js';
import type { Bitrix24RestClient } from '../bitrix24/rest/rest-client.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { MessengerInboxService, phoneOfChat, previewOf } from './messenger-inbox.service.js';
import { MessengerServiceClient } from './messenger-service.client.js';
import { MediaLinks } from './media-links.js';

/** Коннектор приложения на вид мессенджера (один на портал, линий — сколько угодно). */
export const connectorId = (kind: string) => `btx24_${kind}`;
/** События коннектора: сообщение оператора, его правка и удаление; отключение линии. */
export const CONNECTOR_EVENTS = ['ONIMCONNECTORMESSAGEADD', 'ONIMCONNECTORMESSAGEUPDATE', 'ONIMCONNECTORMESSAGEDELETE', 'ONIMCONNECTORSTATUSDELETE', 'ONIMCONNECTORLINEDELETE'] as const;
const LABELS: Record<string, string> = { whatsapp: 'WhatsApp', telegram: 'Telegram', max: 'MAX' };
const COLORS: Record<string, string> = { whatsapp: '#25D366', telegram: '#2AABEE', max: '#7B3FE4' };
const ICON = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#fff" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Z"/></svg>');

/** Повтор необработанных событий линии: раз в 30 с, до 5 попыток, за последний час. */
const RETRY_MS = 30_000;
const MAX_ATTEMPTS = 5;

type OperatorFile = { name?: string; link?: string; url?: string; downloadLink?: string; urlDownload?: string; type?: string };
type ConnectorItem = { im?: { chat_id?: number; message_id?: number }; message?: { id?: string | string[]; text?: string; user_id?: number; files?: OperatorFile[] }; chat?: { id?: string } };
/** Файл оператора не больше — скачиваем и отправляем клиенту. */
const MAX_OPERATOR_FILE = 64 * 1024 * 1024;

/**
 * Текст оператора из открытой линии (BBCode) → разметка WhatsApp. Telegram — простым текстом: сервис
 * отправляет его без разметки, и `*…*` остались бы звёздочками.
 */
export function bbToMessenger(text: string, kind = 'whatsapp'): string {
  const plain = kind === 'telegram';
  return text
    .replace(/\[br\]/gi, '\n')
    .replace(/\[b\]([\s\S]*?)\[\/b\]/gi, plain ? '$1' : '*$1*')
    .replace(/\[i\]([\s\S]*?)\[\/i\]/gi, plain ? '$1' : '_$1_')
    .replace(/\[s\]([\s\S]*?)\[\/s\]/gi, plain ? '$1' : '~$1~')
    .replace(/\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/gi, '$2 ($1)')
    .replace(/\[\/?[a-z]+(?:=[^\]]*)?\]/gi, '')
    .trim();
}

/**
 * Своя открытая линия приложения (ADR 0014): приложение — коннектор `imconnector` Битрикс24.
 * Клиент пишет в мессенджер → `imconnector.send.messages` (правка — `update.messages`, удаление у
 * всех — `delete.messages`); оператор пишет в линии → событие `OnImConnectorMessageAdd` → отправка в
 * мессенджер и `send.status.delivery` (правка и удаление оператора — тоже). Всё — токеном приложения
 * (методы коннектора работают только в контексте приложения).
 */
@Injectable()
export class MessengerConnectorService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(MessengerConnectorService.name);
  private timer: NodeJS.Timeout | undefined;
  constructor(
    private readonly prisma: PrismaService,
    private readonly portals: PortalService,
    private readonly service: MessengerServiceClient,
    private readonly inbox: MessengerInboxService,
    @Inject(B24_CONFIG) private readonly config: Bitrix24Config,
    private readonly links: MediaLinks,
  ) {}

  onModuleInit() {
    onBitrixEvent('ONIMCONNECTOR', (portal, event, data) => this.fromBitrix(portal, event, data));
    this.timer = setInterval(() => void this.retry().catch((err: unknown) => this.logger.warn(`retry: ${err instanceof Error ? err.message : String(err)}`)), RETRY_MS);
    this.inbox.listen({
      incoming: (m, msg, name) => this.toBitrix(m, msg, name, 'send'),
      edited: (m, msg) => this.toBitrix(m, msg, null, 'update'),
      revoked: (m, msg) => this.toBitrix(m, msg, null, 'delete'),
    });
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Очередь действий линии: событие, которое не удалось выполнить (мессенджер не подключён, сбой
   * сети), выполняется повторно. Попытка — в начале `error` (`[n] …`); после 5-й — больше не трогаем.
   */
  async retry(now = Date.now()): Promise<void> {
    const failed = await this.prisma.bitrix24Event.findMany({
      where: { status: 'FAILED', event: { startsWith: 'ONIMCONNECTOR' }, receivedAt: { gt: new Date(now - 3600_000) }, processedAt: { lt: new Date(now - RETRY_MS) } },
      orderBy: { receivedAt: 'asc' },
      take: 50,
      include: { portal: true },
    });
    for (const e of failed) {
      const attempt = Number(/^\[(\d+)\]/.exec(e.error ?? '')?.[1] ?? 1) + 1;
      if (attempt > MAX_ATTEMPTS) continue;
      try {
        await this.fromBitrix(e.portal, e.event, (e.payload as { data?: unknown } | null)?.data ?? null);
        await this.prisma.bitrix24Event.update({ where: { id: e.id }, data: { status: 'PROCESSED', processedAt: new Date(), error: null } });
      } catch (err) {
        const message = `[${attempt}] ${err instanceof Error ? err.message : String(err)}`.slice(0, 2000);
        await this.prisma.bitrix24Event.update({ where: { id: e.id }, data: { error: message, processedAt: new Date() } });
      }
    }
  }

  /**
   * Первое сообщение клиенту, у которого ещё нет чата в линии: доставляем в мессенджер, затем
   * открываем чат в линии этим сообщением от имени сотрудника (`message.user_id`) — в Битрикс24 видно,
   * кто и что написал. Дальше переписка идёт через линию.
   */
  async firstContact(user: B24UserContext, m: Messenger, chatId: string, text: string, file?: { mime: string; name: string; data: Buffer }, dealId?: number | null): Promise<MessengerMessage> {
    const w = await this.service.send(m.id, chatId, text, undefined, file);
    const row = await this.inbox.message(m, w, { source: 'app', sentByUserId: user.userId, ...(dealId !== undefined ? { dealId, awaitingDeal: false } : {}) });
    const portal = await this.prisma.portal.findFirst({ where: { id: m.portalId, status: 'ACTIVE' } });
    if (!portal || !m.lineId) return row;
    const chat = await this.prisma.messengerChat.findUnique({ where: { messengerId_chatId: { messengerId: m.id, chatId: w.chatId } } });
    const phone = chat?.phone ?? w.phone ?? phoneOfChat(chatId);
    const name = chat?.name ?? (phone ? `+${phone}` : chatId);
    const relayChatId = await this.relayTarget(m, row);
    try {
      const res = await this.portals.clientFor(portal).call<{ DATA?: { RESULT?: { SUCCESS?: boolean; session?: { CHAT_ID?: string } }[] } }>('imconnector.send.messages', {
        CONNECTOR: connectorId(m.kind),
        LINE: m.lineId,
        MESSAGES: [
          {
            // Чат — как его назвал WhatsApp (`…@lid` или `…@c.us`): так же придут ответы клиента.
            user: { id: w.chatId, name, ...(phone ? { phone: `+${phone}`, skip_phone_validate: 'Y' } : {}) },
            message: {
              id: w.id,
              date: w.timestamp,
              user_id: user.userId,
              ...(row.dealId ? { disable_crm: 'Y' } : {}),
              ...(text ? { text } : {}),
              ...(w.media && this.links.url(m.id, w.media.fileId) ? { files: [{ url: this.links.url(m.id, w.media.fileId), name: w.media.name ?? 'file' }] } : {}),
            },
            chat: { id: relayChatId, name: row.dealId ? `${name} · Сделка #${row.dealId}` : name },
          },
        ],
      });
      const b24ChatId = Number(res.result?.DATA?.RESULT?.[0]?.session?.CHAT_ID) || null;
      return this.prisma.messengerMessage.update({ where: { id: row.id }, data: { relayedAt: new Date(), relayError: null, b24ChatId, relayChatId } });
    } catch (err) {
      return this.prisma.messengerMessage.update({ where: { id: row.id }, data: { relayError: `Не передано в открытую линию: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500) } });
    }
  }

  private handler(): string {
    const base = this.config.appBaseUrl?.replace(/\/$/, '');
    if (!base) throw new Bitrix24Error('APP_BASE_URL_MISSING', 'APP_BASE_URL не задан — коннектор не зарегистрировать');
    return base;
  }

  /** Зарегистрировать коннектор вида и подписаться на его события (повтор безопасен). */
  async ensureConnector(client: Bitrix24RestClient, kind: string): Promise<void> {
    const base = this.handler();
    await client.call('imconnector.register', {
      ID: connectorId(kind),
      NAME: `${LABELS[kind] ?? kind} (приложение бронирования)`,
      ICON: { DATA_IMAGE: ICON, COLOR: COLORS[kind] ?? '#69acc0', SIZE: '90%', POSITION: 'center' },
      PLACEMENT_HANDLER: `${base}/`,
      DEL_EXTERNAL_MESSAGES: true,
      EDIT_INTERNAL_MESSAGES: true,
      DEL_INTERNAL_MESSAGES: true,
      NEED_SYSTEM_MESSAGES: false,
      NEED_SIGNATURE: true,
      CHAT_GROUP: false,
    });
    for (const event of CONNECTOR_EVENTS)
      await client.call('event.bind', { event, handler: `${base}/api/b24/events` }).catch((err: unknown) => {
        if (!(err instanceof Bitrix24Error && /already|exist/i.test(err.message))) throw err;
      });
  }

  /** Создать свою открытую линию для мессенджера и подключить к ней коннектор. */
  async createOwnLine(portal: Portal, m: Messenger, name: string): Promise<{ lineId: number; name: string }> {
    const client = this.portals.clientFor(portal);
    await this.ensureConnector(client, m.kind);
    const res = await client.call<number | string>('imopenlines.config.add', { PARAMS: { LINE_NAME: name } });
    const lineId = Number(res.result);
    if (!lineId) throw new Bitrix24Error('LINE_NOT_CREATED', 'Битрикс24 не вернул номер открытой линии');
    await this.attach(client, m, lineId);
    return { lineId, name };
  }

  /** Подключить коннектор к линии и передать ей данные канала. */
  async attach(client: Bitrix24RestClient, m: Messenger, lineId: number): Promise<void> {
    const CONNECTOR = connectorId(m.kind);
    await client.call('imconnector.activate', { CONNECTOR, LINE: lineId, ACTIVE: '1' });
    const title = `${LABELS[m.kind] ?? m.kind} +${m.phone}`;
    await client.call('imconnector.connector.data.set', { CONNECTOR, LINE: lineId, DATA: { id: m.id, url: `https://wa.me/${m.phone}`, url_im: `https://wa.me/${m.phone}`, name: title } });
  }

  /** Отключить коннектор от своей линии (сопоставление снято). Линию в Битрикс24 не удаляем. */
  async detach(portal: Portal, m: Messenger): Promise<void> {
    if (m.lineMode !== 'own' || !m.lineId) return;
    await this.portals.clientFor(portal).call('imconnector.activate', { CONNECTOR: connectorId(m.kind), LINE: m.lineId, ACTIVE: '0' }).catch(() => undefined);
  }

  // ---------- мессенджер → открытая линия ----------

  async publishChosen(m: Messenger, msg: MessengerMessage): Promise<void> {
    await this.toBitrix(m, msg, null, 'send', true);
  }

  private async relayTarget(m: Messenger, msg: MessengerMessage): Promise<string> {
    const prior = msg.dealId ? await this.prisma.messengerMessage.findFirst({ where: { portalId: m.portalId, messengerId: m.id, chatId: msg.chatId, b24ChatId: { not: null }, dealId: msg.dealId }, orderBy: { sentAt: 'desc' } }) : null;
    const other = msg.dealId && !prior ? await this.prisma.messengerMessage.findFirst({ where: { portalId: m.portalId, messengerId: m.id, chatId: msg.chatId, b24ChatId: { not: null }, dealId: { not: null } } }) : null;
    return msg.relayChatId ?? prior?.relayChatId ?? (prior ? msg.chatId : msg.dealId && other ? `${msg.chatId}::deal:${msg.dealId}` : msg.chatId);
  }

  private async toBitrix(m: Messenger, msg: MessengerMessage, name: string | null, op: 'send' | 'update' | 'delete', explicitChannel = false): Promise<void> {
    if (m.lineMode !== 'own' || !m.lineId) return;
    // Группы в открытую линию не передаём: линия — переписка один на один.
    if (msg.chatId.endsWith('@g.us')) return;
    // Новый канал к найденной сделке открывает сотрудник. До выбора сообщение видно в приложении.
    if (op === 'send' && !explicitChannel && (msg.dealId || msg.awaitingDeal)) {
      const known = await this.prisma.messengerMessage.findFirst({ where: { portalId: m.portalId, messengerId: m.id, chatId: msg.chatId, b24ChatId: { not: null } } });
      if (!known) return;
    }
    const portal = await this.prisma.portal.findFirst({ where: { id: m.portalId, status: 'ACTIVE' } });
    if (!portal) return;
    const client = this.portals.clientFor(portal);
    const chat = await this.prisma.messengerChat.findUnique({ where: { messengerId_chatId: { messengerId: m.id, chatId: msg.chatId } } });
    const phone = chat?.phone ?? phoneOfChat(msg.chatId);
    const userName = name ?? chat?.name ?? (phone ? `+${phone}` : msg.chatId);
    const relayChatId = await this.relayTarget(m, msg);
    const user = { id: msg.chatId, name: userName, ...(phone ? { phone: `+${phone}`, skip_phone_validate: 'Y' } : {}) };
    // Вложение — ссылкой (Битрикс24 скачивает сам); не скачано — подпись «[фото]».
    const fileUrl = msg.mediaId ? this.links.url(m.id, msg.mediaId) : null;
    const files = fileUrl ? [{ url: fileUrl, name: msg.mediaName ?? 'file' }] : undefined;
    const item = {
      user,
      message: { ...(msg.dealId || msg.awaitingDeal ? { disable_crm: 'Y' } : {}), id: msg.externalId, date: Math.floor(msg.sentAt.getTime() / 1000), ...(files ? { files, ...(msg.body.trim() ? { text: msg.body } : {}) } : { text: previewOf(msg) || ' ' }) },
      chat: { id: relayChatId, name: msg.dealId ? `${userName} · Сделка #${msg.dealId}` : userName },
    };
    const method = op === 'send' ? 'imconnector.send.messages' : op === 'update' ? 'imconnector.update.messages' : 'imconnector.delete.messages';
    const payload = op === 'delete' ? { user: { id: msg.chatId }, message: { id: msg.externalId }, chat: { id: relayChatId } } : item;
    const res = await client.call<{ SUCCESS?: boolean; DATA?: { RESULT?: { SUCCESS?: boolean; session?: { CHAT_ID?: string }; ERRORS?: unknown }[] } }>(method, {
      CONNECTOR: connectorId(m.kind),
      LINE: m.lineId,
      MESSAGES: [payload],
    });
    const r = res.result?.DATA?.RESULT?.[0];
    if (res.result?.SUCCESS === false || r?.SUCCESS === false) throw new Bitrix24Error('CONNECTOR_REJECTED', `Открытая линия не приняла сообщение: ${JSON.stringify(r?.ERRORS ?? res.result).slice(0, 300)}`);
    await this.prisma.messengerMessage.update({
      where: { id: msg.id },
      data: { relayedAt: new Date(), relayError: null, relayChatId, ...(r?.session?.CHAT_ID ? { b24ChatId: Number(r.session.CHAT_ID) } : {}) },
    });
  }

  // ---------- открытая линия → мессенджер ----------

  async fromBitrix(portal: Portal, event: string, data: unknown): Promise<void> {
    const d = (data ?? {}) as { CONNECTOR?: string; LINE?: number | string; MESSAGES?: ConnectorItem[] };
    const lineId = Number(d.LINE);
    if (event === 'ONIMCONNECTORSTATUSDELETE' || event === 'ONIMCONNECTORLINEDELETE') {
      // Коннектор отключили (или линию удалили) в Битрикс24 — сопоставление снимаем.
      if (lineId) await this.prisma.messenger.updateMany({ where: { portalId: portal.id, lineMode: 'own', lineId }, data: { lineMode: null, lineId: null, lineName: null } });
      return;
    }
    const m = await this.prisma.messenger.findFirst({ where: { portalId: portal.id, lineMode: 'own', lineId } });
    if (!m || (d.CONNECTOR && d.CONNECTOR !== connectorId(m.kind))) return;
    const client = this.portals.clientFor(portal);
    for (const item of d.MESSAGES ?? []) {
      const chatId = item.chat?.id;
      const b24MessageId = Number(item.im?.message_id) || null;
      if (!chatId) continue;
      if (event === 'ONIMCONNECTORMESSAGEADD') {
        // Повтор события: уже отправлено — только подтверждаем доставку. Первое сообщение из приложения
        // (`firstContact`) линия может прислать эхом — узнаём его по чату и тексту, второй раз не шлём.
        const text = bbToMessenger(item.message?.text ?? '', m.kind);
        const done =
          (b24MessageId ? await this.prisma.messengerMessage.findFirst({ where: { messengerId: m.id, b24MessageId } }) : null) ??
          (await this.echoOfFirstContact(m, chatId, Number(item.im?.chat_id) || null, text, b24MessageId, !!item.message?.files?.length));
        const files = item.message?.files ?? [];
        const ids = done && (!files.length || done.source !== 'bitrix') ? [done.externalId] : await this.sendFromLine(portal, m, chatId, text, item);
        await this.delivered(client, m, item, ids);
      } else {
        const ids = ([] as string[]).concat(item.message?.id ?? []).filter(Boolean);
        for (const externalId of ids) {
          if (event === 'ONIMCONNECTORMESSAGEUPDATE') {
            const w = await this.service.edit(m.id, externalId, bbToMessenger(item.message?.text ?? '', m.kind));
            await this.inbox.edit(m, externalId, w.body, '', Math.floor(Date.now() / 1000));
          } else {
            await this.service.deleteMessage(m.id, externalId, true);
            await this.inbox.revoke(m, externalId, Math.floor(Date.now() / 1000));
          }
        }
        if (event === 'ONIMCONNECTORMESSAGEUPDATE') await this.delivered(client, m, item, ids);
      }
    }
  }

  private async echoOfFirstContact(m: Messenger, chatId: string, b24ChatId: number | null, text: string, b24MessageId: number | null, hasFiles = false): Promise<MessengerMessage | null> {
    if (!b24ChatId) return null;
    const recent = await this.prisma.messengerMessage.findMany({
      where: { messengerId: m.id, chatId: chatId.split('::deal:')[0], source: 'app', b24ChatId, b24MessageId: null, sentAt: { gt: new Date(Date.now() - 5 * 60_000) } },
      orderBy: { sentAt: 'desc' },
      take: 5,
    });
    // Файл без подписи узнаём по вложению, а не по пустому тексту (иначе «совпадёт» любое сообщение).
    const hit = recent.find((r) => (r.body.trim() ? text.endsWith(r.body.trim()) : r.hasMedia && hasFiles));
    if (hit && b24MessageId) await this.prisma.messengerMessage.update({ where: { id: hit.id }, data: { b24MessageId } });
    return hit ?? null;
  }

  /** Сообщение оператора → клиенту: текст и вложения (каждое — отдельным сообщением, подпись — у первого). */
  private async sendFromLine(portal: Portal, m: Messenger, chatId: string, text: string, item: ConnectorItem): Promise<string[]> {
    const files = item.message?.files ?? [];
    const sent = files.length && item.im?.message_id ? await this.prisma.messengerMessage.findMany({ where: { messengerId: m.id, chatId: chatId.split('::deal:')[0], b24MessageId: Number(item.im.message_id), source: 'bitrix' }, orderBy: [{ sentAt: 'asc' }, { id: 'asc' }] }) : [];
    const out: string[] = sent.map(row => row.externalId);
    let caption = sent.length ? '' : text;
    for (const f of files.slice(sent.length)) {
      const file = await this.operatorFile(portal, f);
      if (!file) throw new Error('Не удалось скачать вложение оператора');
      out.push((await this.saveFromLine(m, await this.service.send(m.id, chatId.split('::deal:')[0], caption, undefined, file), item)).externalId);
      caption = '';
    }
    if (caption || !out.length) out.push((await this.saveFromLine(m, await this.service.send(m.id, chatId.split('::deal:')[0], caption || ' '), item)).externalId);
    return out;
  }

  /** Скачать файл оператора — только с адреса самого портала (ссылки из события), не больше 64 МБ. */
  private async operatorFile(portal: Portal, f: OperatorFile): Promise<{ mime: string; name: string; data: Buffer } | null> {
    let url = new URL(String(f.link ?? f.downloadLink ?? f.urlDownload ?? f.url));
    let res: Response | undefined;
    for (let redirects = 0; redirects < 4; redirects++) {
      if (url.protocol !== 'https:' || url.hostname !== portal.domain || (url.port && url.port !== '443') || url.username || url.password) throw new Error('Файл доступен только с HTTPS-адреса портала');
      res = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: 'manual' });
      if (![301,302,303,307,308].includes(res.status)) break;
      const next = res.headers.get('location'); await res.body?.cancel();
      if (!next) throw new Error('Нет адреса перенаправления файла');
      url = new URL(next, url); res = undefined;
    }
    if (!res?.ok) throw new Error(`Файл не скачан: HTTP ${res?.status ?? 'redirect'}`);
    if (Number(res.headers.get('content-length')) > MAX_OPERATOR_FILE) { await res.body?.cancel(); throw new Error('Файл больше 64 МБ'); }
    const chunks: Uint8Array[] = []; let size = 0;
    const reader = res.body?.getReader();
    if (!reader) throw new Error('Файл без содержимого');
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > MAX_OPERATOR_FILE) { await reader.cancel(); throw new Error('Файл больше 64 МБ'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const data = Buffer.concat(chunks, size);

    return { mime: res.headers.get('content-type')?.split(';')[0] ?? f.type ?? 'application/octet-stream', name: f.name ?? 'file', data };
  }

  private async saveFromLine(m: Messenger, w: Awaited<ReturnType<MessengerServiceClient['send']>>, item: ConnectorItem): Promise<MessengerMessage> {
    const history = item.im?.chat_id ? await this.prisma.messengerMessage.findFirst({ where: { portalId: m.portalId, messengerId: m.id, b24ChatId: Number(item.im.chat_id), dealId: { not: null } }, orderBy: { sentAt: 'desc' } }) : null;
    return this.inbox.message(m, w, {
      source: 'bitrix',
      ...(history?.dealId ? { dealId: history.dealId, awaitingDeal: false, relayChatId: history.relayChatId } : {}),
      ...(item.chat?.id?.includes('::deal:') ? { dealId: Number(item.chat.id.split('::deal:')[1]), awaitingDeal: false, relayChatId: item.chat.id } : {}),
      sentByUserId: Number(item.message?.user_id) || null,
      b24MessageId: Number(item.im?.message_id) || null,
      b24ChatId: Number(item.im?.chat_id) || null,
      relayedAt: new Date(),
    });
  }

  private async delivered(client: Bitrix24RestClient, m: Messenger, item: ConnectorItem, externalIds: string[]): Promise<void> {
    await client.call('imconnector.send.status.delivery', {
      CONNECTOR: connectorId(m.kind),
      LINE: m.lineId,
      MESSAGES: [{ im: item.im, message: { id: externalIds, date: Math.floor(Date.now() / 1000) }, chat: { id: item.chat?.id } }],
    });
  }
}
