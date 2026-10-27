import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit, Optional } from '@nestjs/common';
import type { Messenger, MessengerChat, MessengerMessage, Portal } from '../../generated/prisma/client.js';
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
import { MessengerCrmService } from './messenger-crm.service.js';
import { chatLineProblem } from '../openlines/line-health.js';

/** Коннектор приложения на вид мессенджера (один на портал, линий — сколько угодно). */
/** Аватар собеседника переспрашиваем у сервиса раз в сутки. */
const AVATAR_CACHE_MS = 24 * 3600_000;
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
/** Отправленное с телефона ждёт столько, прежде чем уйти в линию: своё из приложения/линии за это время получит источник. */
const OUTGOING_DELAY_MS = 5_000;
/** Группа впервые попадает в линию — вместе с пропущенными сообщениями за столько (но не раньше добавления номера: до него группу вёл прежний канал). */
const GROUP_BACKLOG_MS = 3 * 24 * 3600_000;
/**
 * Метка сообщения сотрудника с телефона: в линию оно уходит от имени клиента (коннектор не может
 * написать от сотрудника без события отправки клиенту), приложение по метке показывает его как наше —
 * так же, как у Wazzup (`phoneOutgoing` в `openlines/chat-parsing.ts`).
 */
export const PHONE_MARK = '=== Исходящее сообщение, автор: Телефон ===';
const isGroup = (chatId: string) => chatId.endsWith('@g.us');

/** Контакты клиента для `user` линии: номер мессенджера, иначе — связанного контакта CRM; его почта. */
export function lineUser(phone: string | null | undefined, who: { phone: string | null; email: string | null } | null): { phone?: string; skip_phone_validate?: 'Y'; email?: string } {
  const p = phone ? `+${phone}` : who?.phone;
  return { ...(p ? { phone: p, skip_phone_validate: 'Y' as const } : {}), ...(who?.email ? { email: who.email } : {}) };
}

/** Текст для линии: с телефона — с меткой, в группе — с именем автора. */
export function lineText(msg: Pick<MessengerMessage, 'fromMe' | 'chatId' | 'body' | 'type' | 'hasMedia'>, author: string | null, withFile: boolean): string {
  const base = withFile ? msg.body.trim() : previewOf(msg);
  if (msg.fromMe) return base ? `${PHONE_MARK}\n${base}` : PHONE_MARK;
  if (isGroup(msg.chatId) && author) return base ? `${author}:\n${base}` : `${author}:`;
  return base;
}

/** Файл оператора не больше — скачиваем и отправляем клиенту. */
const MAX_OPERATOR_FILE = 64 * 1024 * 1024;

/**
 * Текст оператора из открытой линии (BBCode) → разметка WhatsApp. Telegram и MAX — простым текстом:
 * сервис отправляет его без разметки, и `*…*` остались бы звёздочками.
 */
export function bbToMessenger(text: string, kind = 'whatsapp'): string {
  const plain = kind === 'telegram' || kind === 'max';
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
    @Optional() private readonly crm?: MessengerCrmService,
  ) {}

  /**
   * Клиент нового диалога для CRM-трекера линии — телефон и почта связанного контакта: Битрикс24 ищет
   * клиента диалога по ним. Без этого Telegram-клиент без номера становился новым контактом и сделкой.
   */
  private async identity(portal: Portal, chat: MessengerChat | null): Promise<{ phone: string | null; email: string | null } | null> {
    if (!chat?.crmContactId || !this.crm) return null;
    try {
      const c = await this.crm.comms(portal, chat.crmContactId);
      return c.phone || c.email ? c : null;
    } catch {
      return null;
    }
  }

  /**
   * У найденного клиента есть рабочий чат в другой линии — новый канал тогда открывает сотрудник (не
   * плодим конкурирующие диалоги). Все прежние чаты на выключенных линиях (Wazzup) — конкурента нет.
   * Проверить не удалось — считаем, что есть: сообщение подождёт выбора в приложении.
   */
  private async hasWorkingChat(portal: Portal, chat: MessengerChat | null): Promise<boolean> {
    const dealIds = ((chat?.crmMatch as { dealIds?: number[] } | null)?.dealIds ?? []).slice(0, 5);
    const entities = [...(chat?.crmContactId ? [{ type: 'contact', id: chat.crmContactId }] : []), ...dealIds.map((id) => ({ type: 'deal', id }))];
    if (!entities.length) return true;
    try {
      const client = this.portals.clientFor(portal);
      const ids = new Set<number>();
      for (const e of entities) {
        const r = await client.call<{ CHAT_ID?: string | number }[]>('imopenlines.crm.chat.get', { CRM_ENTITY_TYPE: e.type, CRM_ENTITY: e.id, ACTIVE_ONLY: 'N' });
        for (const c of r.result ?? []) if (Number(c.CHAT_ID) > 0) ids.add(Number(c.CHAT_ID));
      }
      for (const id of ids) if (!(await chatLineProblem(client, this.prisma, portal.id, id))) return true;
      return false;
    } catch {
      return true;
    }
  }

  /** Аватар собеседника: ID файла у сервиса или null (нет фото) — на сутки на процесс, без повторных запросов. */
  private readonly avatars = new Map<string, { fileId: string | null; at: number }>();

  /** Фото клиента для `user.picture` линии; любые сбои — без фото (сообщение важнее аватара). */
  async pictureOf(m: Messenger, chatId: string): Promise<{ url: string } | undefined> {
    if (!/@(c\.us|lid)$/.test(chatId)) return undefined;
    const key = `${m.id}|${chatId}`;
    let hit = this.avatars.get(key);
    if (!hit || Date.now() - hit.at > AVATAR_CACHE_MS) {
      let media: { fileId: string } | null = null;
      try { media = await this.service.avatar(m.id, chatId); } catch { /* Сервис без фото или недоступен. */ }
      hit = { fileId: media?.fileId ?? null, at: Date.now() };
      this.avatars.set(key, hit);
    }
    const url = hit.fileId ? this.links.url(m.id, hit.fileId) : null;
    return url ? { url } : undefined;
  }

  onModuleInit() {
    onBitrixEvent('ONIMCONNECTOR', (portal, event, data) => this.fromBitrix(portal, event, data));
    this.timer = setInterval(() => void this.retry().catch((err: unknown) => this.logger.warn(`retry: ${err instanceof Error ? err.message : String(err)}`)), RETRY_MS);
    this.inbox.listen({
      incoming: (m, msg, name) => this.toBitrix(m, msg, isGroup(msg.chatId) ? null : name, 'send'),
      outgoing: async (m, msg) => {
        setTimeout(() => void this.fromPhone(m, msg.id).catch((err: unknown) => this.logger.warn(`phone ${msg.externalId}: ${err instanceof Error ? err.message : String(err)}`)), OUTGOING_DELAY_MS).unref?.();
      },
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
  async firstContact(user: B24UserContext, m: Messenger, chatId: string, text: string, file?: { mime: string; name: string; data: Buffer }, dealId?: number | null, contactId?: number): Promise<MessengerMessage> {
    const w = await this.service.send(m.id, chatId, text, undefined, file);
    // Мессенджер мог вернуть другой адрес собеседника (номер → скрытый ID): клиент CRM — и у него.
    if (contactId && this.crm) await this.crm.pin(m, w.chatId, { dealId: dealId ?? null, contactId }, w.phone);
    const row = await this.inbox.message(m, w, { source: 'app', sentByUserId: user.userId, ...(dealId !== undefined ? { dealId, awaitingDeal: false } : {}) });
    const portal = await this.prisma.portal.findFirst({ where: { id: m.portalId, status: 'ACTIVE' } });
    if (!portal || !m.lineId) return row;
    const chat = await this.prisma.messengerChat.findUnique({ where: { messengerId_chatId: { messengerId: m.id, chatId: w.chatId } } });
    const phone = chat?.phone ?? w.phone ?? phoneOfChat(chatId);
    const name = chat?.name ?? (phone ? `+${phone}` : chatId);
    const relayChatId = await this.relayTarget(m, row);
    const picture = await this.pictureOf(m, w.chatId);
    // Чат к сделке (`::deal:`) — второй диалог того же клиента: трекер не нужен.
    const who = relayChatId.includes('::deal:') ? null : await this.identity(portal, chat);
    try {
      const res = await this.portals.clientFor(portal).call<{ DATA?: { RESULT?: { SUCCESS?: boolean; session?: { CHAT_ID?: string } }[] } }>('imconnector.send.messages', {
        CONNECTOR: connectorId(m.kind),
        LINE: m.lineId,
        MESSAGES: [
          {
            // Чат — как его назвал WhatsApp (`…@lid` или `…@c.us`): так же придут ответы клиента.
            user: { id: w.chatId, name, ...lineUser(phone, who), ...(picture ? { picture } : {}) },
            message: {
              id: w.id,
              date: w.timestamp,
              user_id: user.userId,
              ...(row.dealId && !who ? { disable_crm: 'Y' } : {}),
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

  /**
   * Сообщение сотрудника, отправленное с телефона, — в линию (иначе в «Чатах» его не видно). Сервис
   * присылает и своё отправленное приложением/линией: ждём, пока у него появится источник, и такое
   * не трогаем. Личный чат — только если диалог в линии уже есть (новый диалог открывает приложение).
   */
  async fromPhone(m: Messenger, rowId: string): Promise<void> {
    const row = await this.prisma.messengerMessage.findUnique({ where: { id: rowId } });
    if (!row || !row.fromMe || row.source !== 'messenger' || row.relayedAt || row.deletedAt) return;
    if (!isGroup(row.chatId)) {
      const known = await this.prisma.messengerMessage.findFirst({ where: { portalId: m.portalId, messengerId: m.id, chatId: row.chatId, relayedAt: { not: null } }, select: { id: true } });
      if (!known) return;
    }
    try {
      await this.toBitrix(m, row, null, 'send');
    } catch (err) {
      await this.prisma.messengerMessage.update({ where: { id: row.id }, data: { relayError: `Не передано в открытую линию: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500) } });
    }
  }

  /** Названия групп и имена участников от сервиса — на процесс (подпись в линии). */
  private readonly names = new Map<string, string | null>();
  private async nameOf(m: Messenger, id: string | null): Promise<string | null> {
    if (!id) return null;
    const key = `${m.id}|${id}`;
    if (!this.names.has(key)) {
      const got = await this.service.names(m.id, [id]).catch(() => ({}) as Record<string, string>);
      this.names.set(key, got[id] ?? null);
    }
    return this.names.get(key) ?? null;
  }

  /** Группа впервые в линии: сначала пропущенные сообщения (по порядку), потом текущее. */
  private async groupBacklog(m: Messenger, msg: MessengerMessage): Promise<void> {
    const since = Math.max(Date.now() - GROUP_BACKLOG_MS, m.createdAt.getTime());
    const rows = await this.prisma.messengerMessage.findMany({
      where: { portalId: m.portalId, messengerId: m.id, chatId: msg.chatId, source: 'messenger', relayedAt: null, deletedAt: null, id: { not: msg.id }, sentAt: { gte: new Date(since), lte: msg.sentAt } },
      orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
      take: 100,
    });
    for (const r of rows) await this.relayOne(m, r, null, 'send');
  }

  /**
   * Диалог линии для сообщения: всегда диалог собеседника (ADR 0017 — сделка только метка сообщения,
   * отдельных диалогов под сделку нет). Правка и удаление — в диалог, куда ушло исходное (`relayChatId`,
   * в том числе прежние `<чат>::deal:<id>`).
   */
  private async relayTarget(_m: Messenger, msg: MessengerMessage): Promise<string> {
    return msg.relayChatId ?? msg.chatId;
  }

  private async toBitrix(m: Messenger, msg: MessengerMessage, name: string | null, op: 'send' | 'update' | 'delete', explicitChannel = false): Promise<void> {
    if (m.lineMode !== 'own' || !m.lineId) return;
    // Группа (рабочие чаты сотрудников) — тоже в линию, как было у Wazzup: впервые — с пропущенным.
    if (op === 'send' && isGroup(msg.chatId)) {
      const known = await this.prisma.messengerMessage.findFirst({ where: { portalId: m.portalId, messengerId: m.id, chatId: msg.chatId, relayedAt: { not: null } }, select: { id: true } });
      if (!known) await this.groupBacklog(m, msg);
    }
    await this.relayOne(m, msg, name, op, explicitChannel);
  }

  private async relayOne(m: Messenger, msg: MessengerMessage, name: string | null, op: 'send' | 'update' | 'delete', explicitChannel = false): Promise<void> {
    const group = isGroup(msg.chatId);
    const portal = await this.prisma.portal.findFirst({ where: { id: m.portalId, status: 'ACTIVE' } });
    if (!portal) return;
    const chat = await this.prisma.messengerChat.findUnique({ where: { messengerId_chatId: { messengerId: m.id, chatId: msg.chatId } } });
    const opened = op !== 'send' || group ? true : !!(await this.prisma.messengerMessage.findFirst({ where: { portalId: m.portalId, messengerId: m.id, chatId: msg.chatId, b24ChatId: { not: null } }, select: { id: true } }));
    // Новый канал к найденной сделке открывает сотрудник, если у клиента есть рабочий чат. До выбора сообщение видно в приложении.
    if (op === 'send' && !explicitChannel && (msg.dealId || msg.awaitingDeal) && !opened && (await this.hasWorkingChat(portal, chat))) return;
    const client = this.portals.clientFor(portal);
    const phone = group ? null : (chat?.phone ?? phoneOfChat(msg.chatId));
    // Группа — под своим названием (в списке чатов приложения у старых групп могло остаться имя участника).
    const title = group ? await this.nameOf(m, msg.chatId) : null;
    if (title && chat && chat.name !== title) await this.prisma.messengerChat.update({ where: { id: chat.id }, data: { name: title.slice(0, 255) } });
    const userName = name ?? title ?? chat?.name ?? (phone ? `+${phone}` : msg.chatId);
    const relayChatId = await this.relayTarget(m, msg);
    const picture = op === 'send' && !group ? await this.pictureOf(m, msg.chatId) : undefined;
    // Новый диалог — с телефоном/почтой связанного клиента: линия свяжет его с ним, а не создаст нового.
    const who = !opened && !relayChatId.includes('::deal:') ? await this.identity(portal, chat) : null;
    const user = { id: msg.chatId, name: userName, ...lineUser(phone, who), ...(picture ? { picture } : {}) };
    // Вложение — ссылкой (Битрикс24 скачивает сам); не скачано — подпись «[фото]».
    const fileUrl = msg.mediaId ? this.links.url(m.id, msg.mediaId) : null;
    const files = fileUrl ? [{ url: fileUrl, name: msg.mediaName ?? 'file' }] : undefined;
    const author = group && !msg.fromMe ? (msg.authorName ?? (await this.nameOf(m, msg.author))) : null;
    const text = lineText(msg, author, !!files);
    // Группа — без трекера CRM для сообщений (новый диалог линия всё равно может связать со сделкой — настройка линии CRM_CREATE).
    const noCrm = group || (!who && (msg.dealId || msg.awaitingDeal));
    const item = {
      user,
      message: { ...(noCrm ? { disable_crm: 'Y' } : {}), id: msg.externalId, date: Math.floor(msg.sentAt.getTime() / 1000), ...(files ? { files, ...(text ? { text } : {}) } : { text: text || ' ' }) },
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
