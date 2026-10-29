import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ChatChannelsAdminDto, ChatCrmLinks, ChatMessageDto } from '@btx24/shared';
import type { Portal, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { followMergedContacts } from './merged-contacts.js';
import type { Bitrix24RestClient } from '../bitrix24/rest/rest-client.js';
import { connectorMidOf, connectorOf, crmLinksOf, deliveryFromAck, groupReactions, keepKnownFiles, phoneEchoIds, toMessageDto, UNKNOWN_FILE, type ImFile, type ImMessage, type ImUser } from './chat-parsing.js';
import { autoChannel, conversationKey, entityParts, lineChannel, ownKey } from './conversation-keys.js';

/** Сообщений на страницу ленты (как прежняя история чата). */
export const FEED_LIMIT = 50;
/** Доступ сотрудника к чату переписки перепроверяем его токеном (в фоне) не реже этого. */
const ACCESS_STALE_MS = 5 * 60_000;
/**
 * Сохранённый ответ о доступе годен столько (решение владельца 2026-10-27: права можно держать
 * 2–3 дня — не критично); старше — ждём проверку, а worker удаляет такие строки.
 */
export const ACCESS_MAX_AGE_MS = 3 * 24 * 60 * 60_000;
/** Чатов без линии, дочитываемых за проход worker'а. */
const FILL_PER_PASS = 500;
const BATCH = 50;
/** Линия не определилась (диалог недоступен приложению) — не спрашиваем снова каждую минуту. */
const NO_LINE = -1;
/** Прежние чаты клиента ищем в CRM не чаще этого (на клиента и сотрудника). */
const DISCOVER_TTL_MS = 10 * 60_000;
/** Чатов клиента, добавляемых за одно открытие переписки. */
const DISCOVER_MAX = 50;

type Client = Pick<Bitrix24RestClient, 'call' | 'batch'>;

/** Доставка своего сообщения — по хранимому `mid` (сообщения, сохранённые до появления поля, тоже). */
const withDelivery = (dto: ChatMessageDto, mid: string | null): ChatMessageDto =>
  dto.author?.kind === 'employee' && !dto.viaPhone ? { ...dto, delivery: mid ? 'delivered' : 'sent' } : dto;

export interface ImPage {
  messages?: ImMessage[];
  users?: ImUser[];
  files?: ImFile[];
}

interface Dialog {
  id?: number;
  name?: string;
  role?: string;
  entity_id?: string;
  entity_data_2?: string;
}

/** Чат переписки — строка кэша `OpenlineChat` (нужные поля). */
export interface MemberChat {
  chatId: number;
  connector: string;
  title: string | null;
  lineId: number | null;
  completed: boolean;
  lastMessageAt: Date | null;
  lastMessageId: number | null;
  msgFromId: number | null;
  msgToId: number | null;
  msgComplete: boolean;
}

export interface FeedMessage extends ChatMessageDto {
  chatId: number;
}

export interface Feed {
  /** Чат, в который пишем (последний чат своей линии, иначе — последний доступный). */
  sendChatId: number;
  sendDialog: Dialog | null;
  /** Доступные сотруднику чаты переписки, свежие — первыми. */
  members: (MemberChat & { joined: boolean })[];
  /** Чатов переписки, к которым Битрикс24 сотрудника не пускает. */
  hidden: number;
  messages: FeedMessage[];
  hasMore: boolean;
  /** Свежий хвост открытых чатов (для сводки списка). */
  tails: Map<number, { dialog: Dialog; page: ImPage }>;
  /** Лента — из базы, а сверка с Битрикс24 (доступ, новые сообщения, прежние чаты) нужна: её стоит запустить в фоне. */
  syncing: boolean;
}

const MEMBER_SELECT = {
  chatId: true, connector: true, title: true, lineId: true, completed: true, lastMessageAt: true, lastMessageId: true,
  msgFromId: true, msgToId: true, msgComplete: true, convKey: true,
} as const;

const isMember = (role: string | undefined) => Boolean(role) && !['guest', 'none'].includes(String(role).toLowerCase());

/**
 * Переписки (ADR 0017): клиент × наш канал. Чаты открытых линий одной переписки показываются одним
 * чатом, история — общей лентой. Сообщения хранятся в `OpenlineMessage` (при «сборе текстов»), лента
 * читается из базы; Битрикс24 — для хвоста открытых чатов и догрузки старой истории. Права — токеном
 * сотрудника: в ленту попадают только чаты, к которым Битрикс24 его пускает (`OpenlineChatAccess`).
 */
@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  private readonly discovered = new Map<string, number>();

  // ---------- worker (токен приложения) ----------

  /** Проход worker'а после индекса: каналы линий, линии чатов, ключи переписок. */
  async refresh(portal: Portal, client: Client): Promise<void> {
    await this.syncLines(portal, client);
    await this.fillLines(portal, client);
    const changed = await this.recomputeKeys(portal.id);
    if (changed) this.logger.log(`portal ${portal.id}: ${changed} chats regrouped into conversations`);
  }

  /** Линии портала → наш канал (`ChatLineChannel`); ручной выбор администратора не трогаем. */
  async syncLines(portal: Portal, client: Client): Promise<void> {
    const lines = (await client.call<{ ID: string | number; LINE_NAME?: string }[]>('imopenlines.config.list.get', { PARAMS: { select: ['ID', 'LINE_NAME'] } })).result ?? [];
    const [own, connectors, rows] = await Promise.all([
      this.prisma.messenger.findMany({ where: { portalId: portal.id }, select: { kind: true, phone: true, lineId: true, lineMode: true } }),
      this.prisma.openlineChat.groupBy({ by: ['lineId', 'connector'], where: { portalId: portal.id, lineId: { gt: 0 } } }),
      this.prisma.chatLineChannel.findMany({ where: { portalId: portal.id } }),
    ]);
    const numbers = own.map((m) => ({ kind: m.kind, phone: m.phone, lineId: m.lineMode === 'own' ? m.lineId : null }));
    const existing = new Map(rows.map((r) => [r.lineId, r]));
    const now = new Date();
    for (const l of lines) {
      const id = Number(l.ID);
      if (!(id > 0)) continue;
      const name = String(l.LINE_NAME ?? `Линия ${id}`).slice(0, 255);
      const channel = autoChannel({ id, name, connectors: connectors.filter((c) => c.lineId === id).map((c) => c.connector) }, numbers);
      const prev = existing.get(id);
      if (!prev) await this.prisma.chatLineChannel.create({ data: { portalId: portal.id, lineId: id, lineName: name, channel, auto: true, syncedAt: now } });
      else if (prev.lineName !== name || (prev.auto && prev.channel !== channel))
        await this.prisma.chatLineChannel.update({ where: { id: prev.id }, data: { lineName: name, ...(prev.auto ? { channel } : {}), syncedAt: now } });
    }
  }

  /** Чаты кэша без линии (старые строки) — линия и внешний чат из `imopenlines.dialog.get`. */
  async fillLines(portal: Portal, client: Client): Promise<number> {
    const rows = await this.prisma.openlineChat.findMany({ where: { portalId: portal.id, lineId: null }, select: { chatId: true }, take: FILL_PER_PASS, orderBy: { lastMessageAt: 'desc' } });
    let done = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const part = rows.slice(i, i + BATCH);
      const res = await client.batch(Object.fromEntries(part.map((r) => [`c${r.chatId}`, { method: 'imopenlines.dialog.get', params: { CHAT_ID: r.chatId } }])));
      for (const r of part) {
        const d = res.result[`c${r.chatId}`] as Dialog | undefined;
        const { lineId, extChatId } = entityParts(d?.entity_id);
        await this.prisma.openlineChat.update({
          where: { portalId_chatId: { portalId: portal.id, chatId: r.chatId } },
          data: { lineId: lineId ?? NO_LINE, extChatId },
        });
        done++;
      }
    }
    return done;
  }

  /** Ключи переписок всех чатов портала (сменились привязка CRM, канал линии) — только изменившиеся. */
  async recomputeKeys(portalId: string): Promise<number> {
    const [rows, lines] = await Promise.all([
      this.prisma.openlineChat.findMany({ where: { portalId }, select: { id: true, chatId: true, crm: true, connector: true, lineId: true, extChatId: true, convKey: true } }),
      this.prisma.chatLineChannel.findMany({ where: { portalId }, select: { lineId: true, channel: true } }),
    ]);
    const channels = new Map(lines.map((l) => [l.lineId, l.channel]));
    let changed = 0;
    for (const r of rows) {
      const key = conversationKey({ chatId: r.chatId, crm: r.crm as ChatCrmLinks | null, connector: r.connector, lineId: r.lineId && r.lineId > 0 ? r.lineId : null, extChatId: r.extChatId }, channels);
      if (key === r.convKey) continue;
      await this.prisma.openlineChat.update({ where: { id: r.id }, data: { convKey: key } });
      changed++;
    }
    return changed;
  }

  /** Линии и наши номера для ⚙ → «Каналы линий». */
  async channelsAdmin(portalId: string): Promise<ChatChannelsAdminDto> {
    const [lines, counts, own] = await Promise.all([
      this.prisma.chatLineChannel.findMany({ where: { portalId }, orderBy: { lineId: 'asc' } }),
      this.prisma.openlineChat.groupBy({ by: ['lineId'], where: { portalId }, _count: { _all: true } }),
      this.prisma.messenger.findMany({ where: { portalId }, select: { kind: true, phone: true, title: true }, orderBy: [{ kind: 'asc' }, { phone: 'asc' }] }),
    ]);
    const count = new Map(counts.map((c) => [c.lineId, c._count._all]));
    const kinds: Record<string, string> = { whatsapp: 'WhatsApp', telegram: 'Telegram', max: 'MAX' };
    return {
      lines: lines.map((l) => ({ lineId: l.lineId, lineName: l.lineName, channel: l.channel, auto: l.auto, chats: count.get(l.lineId) ?? 0 })),
      numbers: own.map((m) => ({ channel: `${m.kind}:${m.phone}`, label: `${kinds[m.kind] ?? m.kind} +${m.phone}${m.title ? ` · ${m.title}` : ''}` })),
    };
  }

  /** Выбор администратора: канал линии (`null` — снова автоматически). Переписки пересобираются сразу. */
  async setLineChannel(portal: Portal, lineId: number, channel: string | null, client: Client): Promise<ChatChannelsAdminDto> {
    const row = await this.prisma.chatLineChannel.findUnique({ where: { portalId_lineId: { portalId: portal.id, lineId } } });
    if (!row) throw new NotFoundException({ code: 'LINE_NOT_FOUND', message: 'Линия ещё не загружена — подождите минуту' });
    if (channel !== null) {
      const own = await this.prisma.messenger.findMany({ where: { portalId: portal.id }, select: { kind: true, phone: true } });
      const allowed = new Set([...own.map((m) => `${m.kind}:${m.phone}`), lineChannel(lineId)]);
      if (!allowed.has(channel)) throw new BadRequestException({ code: 'INVALID_CHANNEL', message: 'Канал — наш номер или отдельная переписка линии' });
      await this.prisma.chatLineChannel.update({ where: { id: row.id }, data: { channel, auto: false } });
    } else {
      await this.prisma.chatLineChannel.update({ where: { id: row.id }, data: { auto: true } });
      await this.syncLines(portal, client);
    }
    await this.recomputeKeys(portal.id);
    return this.channelsAdmin(portal.id);
  }

  /** Сбор текстов выключен — хранимая история удаляется. */
  async purge(portalId: string): Promise<number> {
    const { count } = await this.prisma.openlineMessage.deleteMany({ where: { portalId } });
    if (count) await this.prisma.openlineChat.updateMany({ where: { portalId }, data: { msgFromId: null, msgToId: null, msgComplete: false } });
    return count;
  }

  // ---------- хранение ----------

  /**
   * Сохранить страницу сообщений чата. `before` — страница старше этого ID (`LAST_ID`), иначе — последние.
   * Диапазон `[msgFromId, msgToId]` расширяется, только если страница к нему примыкает: ID сообщений в
   * Битрикс24 растут по всему порталу, страница — непрерывный кусок истории чата.
   */
  async store(portalId: string, chatId: number, page: ImPage, before: number | null, limit: number): Promise<void> {
    const raw = page.messages ?? [];
    const users = page.users ?? [];
    const now = new Date();
    if (raw.length) {
      const dtos = raw.map((m) => toMessageDto(m, users, page.files ?? []));
      const blind = dtos.filter((d) => d.files.some((f) => f.type === UNKNOWN_FILE)).map((d) => d.id);
      const prev = blind.length
        ? new Map((await this.prisma.openlineMessage.findMany({ where: { portalId, messageId: { in: blind } }, select: { messageId: true, dto: true } })).map((r) => [r.messageId, r.dto as unknown as ChatMessageDto]))
        : new Map<number, ChatMessageDto>();
      await this.prisma.$transaction(
        raw.map((m, i) => {
          const dto = keepKnownFiles(dtos[i], prev.get(dtos[i].id));
          const data = { chatId, date: new Date(m.date), authorKind: dto.author.kind, mid: connectorMidOf(m)?.slice(0, 190) ?? null, dto: dto as unknown as Prisma.InputJsonValue, syncedAt: now };
          return this.prisma.openlineMessage.upsert({ where: { portalId_messageId: { portalId, messageId: Number(m.id) } }, create: { portalId, messageId: Number(m.id), ...data }, update: data });
        }),
      );
    }
    const row = await this.prisma.openlineChat.findUnique({ where: { portalId_chatId: { portalId, chatId } }, select: { msgFromId: true, msgToId: true, msgComplete: true } });
    if (!row) return;
    const ids = raw.map((m) => Number(m.id));
    const min = ids.length ? Math.min(...ids) : null;
    const max = ids.length ? Math.max(...ids) : null;
    const full = raw.length < limit;
    let next: { msgFromId: number | null; msgToId: number | null; msgComplete: boolean } | null = null;
    if (before === null) {
      if (min === null) next = row.msgToId === null ? { msgFromId: null, msgToId: null, msgComplete: true } : null;
      // Последние сообщения перекрывают хранимый диапазон (или это вся история) — диапазон продолжается.
      else if (row.msgToId !== null && row.msgFromId !== null && (min <= row.msgToId || full))
        next = { msgFromId: full ? min : Math.min(row.msgFromId, min), msgToId: Math.max(row.msgToId, max!), msgComplete: full || row.msgComplete };
      else next = { msgFromId: min, msgToId: max, msgComplete: full };
    } else if (row.msgFromId !== null && row.msgToId !== null && before >= row.msgFromId && before <= row.msgToId + 1) {
      next = { msgFromId: min === null ? row.msgFromId : Math.min(row.msgFromId, min), msgToId: row.msgToId, msgComplete: full };
    }
    if (next) await this.prisma.openlineChat.update({ where: { portalId_chatId: { portalId, chatId } }, data: next });
  }

  // ---------- лента сотрудника ----------

  /**
   * Прежние чаты клиента (ADR 0017): индекс знает только недавние сессии, а в переписке нужна вся
   * история. Чаты контакта/компании/лида — `imopenlines.crm.chat.get` токеном сотрудника (его права);
   * неизвестные кэшу — строкой `OpenlineChat` с линией и ключом переписки.
   */
  async discover(user: { portal: Portal; userId: number; client: Client }, chatId: number): Promise<number> {
    const portalId = user.portal.id;
    const me = await this.prisma.openlineChat.findUnique({ where: { portalId_chatId: { portalId, chatId } }, select: { crm: true } });
    const crm = me?.crm as ChatCrmLinks | null;
    const entity = crm?.contactId ? ['contact', crm.contactId] : crm?.companyId ? ['company', crm.companyId] : crm?.leadId ? ['lead', crm.leadId] : null;
    if (!entity) return 0;
    const key = `${portalId}:${user.userId}:${entity[0]}:${entity[1]}`;
    if ((this.discovered.get(key) ?? 0) > Date.now()) return 0;
    if (this.discovered.size > 5000) this.discovered.clear();
    this.discovered.set(key, Date.now() + DISCOVER_TTL_MS);
    const found = (await user.client.call<{ CHAT_ID?: string | number }[]>('imopenlines.crm.chat.get', { CRM_ENTITY_TYPE: entity[0], CRM_ENTITY: entity[1], ACTIVE_ONLY: 'N' })).result;
    const ids = [...new Set((Array.isArray(found) ? found : []).map((c) => Number(c.CHAT_ID)).filter((id) => id > 0))];
    const known = new Set((await this.prisma.openlineChat.findMany({ where: { portalId, chatId: { in: ids } }, select: { chatId: true } })).map((r) => r.chatId));
    const fresh = ids.filter((id) => !known.has(id)).slice(0, DISCOVER_MAX);
    if (!fresh.length) return 0;
    const res = await user.client.batch(Object.fromEntries(fresh.map((id) => [`c${id}`, { method: 'imopenlines.dialog.get', params: { CHAT_ID: id } }])));
    const channels = new Map((await this.prisma.chatLineChannel.findMany({ where: { portalId }, select: { lineId: true, channel: true } })).map((l) => [l.lineId, l.channel]));
    let added = 0;
    for (const id of fresh) {
      const d = res.result[`c${id}`] as Dialog | undefined;
      if (!d?.id) continue;
      const { lineId, extChatId } = entityParts(d.entity_id);
      const links = crmLinksOf(d.entity_data_2);
      await followMergedContacts(this.prisma, portalId, [links]);
      const connector = connectorOf(d.entity_id).slice(0, 64);
      const convKey = conversationKey({ chatId: id, crm: links, connector, lineId, extChatId }, channels);
      // Сессия, время и сводка — с первым открытием/проходом worker'а; checkedAt — «ещё не индексирован».
      await this.prisma.openlineChat.upsert({
        where: { portalId_chatId: { portalId, chatId: id } },
        create: { portalId, chatId: id, sessionId: 0, completed: true, connector, checkedAt: new Date(0), title: d.name?.slice(0, 255) ?? null, crm: links as unknown as Prisma.InputJsonValue, lineId: lineId ?? NO_LINE, extChatId, convKey },
        update: {},
      });
      added++;
    }
    return added;
  }

  /** Чаты переписки, в которую входит чат (без ключа — сам чат). */
  async membersOf(portalId: string, chatId: number): Promise<(MemberChat & { convKey: string })[]> {
    const me = await this.prisma.openlineChat.findUnique({ where: { portalId_chatId: { portalId, chatId } }, select: MEMBER_SELECT });
    if (!me) return [];
    const key = me.convKey ?? ownKey(chatId);
    const rows = me.convKey ? await this.prisma.openlineChat.findMany({ where: { portalId, convKey: me.convKey }, select: MEMBER_SELECT }) : [me];
    return rows.map((r) => ({ ...r, convKey: key }));
  }

  /**
   * Лента переписки чата `chatId` для сотрудника: сообщения всех доступных ему чатов переписки по
   * возрастанию ID (ID общие для портала), страница — `FEED_LIMIT` старше `beforeId`.
   */
  async feed(
    user: { portal: Portal; userId: number; client: Client },
    chatId: number,
    beforeId: number | null,
    opts: { store: boolean; live?: boolean },
  ): Promise<Feed | null> {
    const portalId = user.portal.id;
    // `live: false` — только база (и то, без чего ленты нет); сверку вызывающий запускает в фоне.
    const sync = opts.live !== false;
    // Первое открытие: прежние чаты клиента — в переписку (сбой поиска ленту не ломает).
    if (beforeId === null && sync)
      await this.discover(user, chatId).catch((e) => this.logger.warn(`discover chats failed: ${e instanceof Error ? e.message : String(e)}`));
    const all = await this.membersOf(portalId, chatId);
    if (!all.length) return null;

    // Доступ: свежий ответ Битрикс24 из базы; остальным и открытым чатам (новые сообщения) — один пакет.
    const access = new Map((await this.prisma.openlineChatAccess.findMany({ where: { portalId, userId: user.userId, chatId: { in: all.map((m) => m.chatId) } } })).map((a) => [a.chatId, a]));
    const now = Date.now();
    const top = beforeId === null;
    const age = (m: MemberChat) => now - (access.get(m.chatId)?.checkedAt.getTime() ?? 0);
    // Доступ без ответа Битрикс24 (или старше 3 дней) — ждём проверку токеном сотрудника; старше
    // 5 минут — из базы, а проверка — со сверкой в фоне.
    const stale = all.filter((m) => age(m) > (sync ? ACCESS_STALE_MS : ACCESS_MAX_AGE_MS));
    const wantsTail = (m: MemberChat) => top && opts.store && (!m.completed || m.msgToId === null || (m.lastMessageId ?? 0) > (m.msgToId ?? 0));
    const tailOf = sync ? all.filter(wantsTail) : [];
    // Заметно отстаёт: доступ давно не проверяли или известно о сообщениях новее хранимых.
    const syncing = !sync && all.some((m) => age(m) > ACCESS_STALE_MS || (top && opts.store && (m.msgToId === null || (m.lastMessageId ?? 0) > m.msgToId)));
    const commands: Record<string, { method: string; params: Record<string, unknown> }> = {};
    for (const m of stale) commands[`d${m.chatId}`] = { method: 'imopenlines.dialog.get', params: { CHAT_ID: m.chatId } };
    for (const m of tailOf) commands[`t${m.chatId}`] = { method: 'im.dialog.messages.get', params: { DIALOG_ID: `chat${m.chatId}`, LIMIT: FEED_LIMIT } };
    const live = Object.keys(commands).length ? await user.client.batch(commands) : { result: {} as Record<string, unknown> };
    const dialogs = new Map<number, Dialog>();
    const checked = new Date();
    for (const m of stale) {
      const d = live.result[`d${m.chatId}`] as Dialog | undefined;
      const allowed = Boolean(d?.id);
      if (allowed) dialogs.set(m.chatId, d!);
      const joined = allowed && isMember(d!.role);
      access.set(m.chatId, { chatId: m.chatId, allowed, joined, checkedAt: checked } as never);
      await this.prisma.openlineChatAccess.upsert({
        where: { portalId_userId_chatId: { portalId, userId: user.userId, chatId: m.chatId } },
        create: { portalId, userId: user.userId, chatId: m.chatId, allowed, joined, checkedAt: checked },
        update: { allowed, joined, checkedAt: checked },
      });
    }
    if (!access.get(chatId)?.allowed) throw new ForbiddenException({ code: 'CHAT_ACCESS_DENIED', message: 'Нет доступа к этому чату в Битрикс24' });

    const members = all
      .filter((m) => access.get(m.chatId)?.allowed)
      .map((m) => ({ ...m, joined: Boolean(access.get(m.chatId)?.joined) }))
      .sort((a, b) => (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0) || b.chatId - a.chatId);
    const tails = new Map<number, { dialog: Dialog; page: ImPage }>();
    for (const m of tailOf) {
      const page = live.result[`t${m.chatId}`] as ImPage | undefined;
      if (!page || !access.get(m.chatId)?.allowed) continue;
      await this.store(portalId, m.chatId, page, null, FEED_LIMIT);
      // Доступ из базы — диалога нет: сводке хватит сообщений (привязки CRM не трогаем).
      tails.set(m.chatId, { dialog: dialogs.get(m.chatId) ?? { id: m.chatId, role: access.get(m.chatId)?.joined ? 'member' : 'guest' }, page });
    }

    const pages = await Promise.all(members.map((m) => this.page(user, m.chatId, beforeId, opts.store)));
    const fetched = pages.flatMap((p) => p.messages);
    // Эхо своих сообщений от Wazzup («с телефона» с тем же MID) — не второе сообщение.
    const echoes = phoneEchoIds(fetched);
    const combined = fetched.filter((m) => !echoes.has(m.id)).sort((a, b) => b.id - a.id);
    const messages = (await this.withReactions(portalId, members, combined.slice(0, FEED_LIMIT))).sort((a, b) => a.id - b.id);
    const send = members.find((m) => m.connector.startsWith('btx24_')) ?? members[0];
    return {
      sendChatId: send.chatId,
      sendDialog: dialogs.get(send.chatId) ?? null,
      members,
      hidden: all.length - members.length,
      messages,
      hasMore: combined.length > FEED_LIMIT || pages.some((p) => p.more),
      tails,
      syncing,
    };
  }

  /** Страница одного чата: из базы, если диапазон хранимой истории её покрывает; иначе — из Битрикс24. */
  private async page(user: { portal: Portal; client: Client }, chatId: number, beforeId: number | null, store: boolean): Promise<{ messages: (FeedMessage & { mid?: string | null })[]; more: boolean }> {
    const portalId = user.portal.id;
    if (store) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const row = await this.prisma.openlineChat.findUnique({ where: { portalId_chatId: { portalId, chatId } }, select: { msgFromId: true, msgToId: true, msgComplete: true } });
        // Покрыто: страница внутри диапазона или старше его начала, когда старше сообщений нет (`msgComplete`).
        const covered = row?.msgFromId != null && row.msgToId != null && (beforeId === null || (beforeId <= row.msgToId + 1 && (beforeId > row.msgFromId || row.msgComplete)));
        if (covered) {
          const rows = await this.prisma.openlineMessage.findMany({
            where: { portalId, chatId, messageId: { gte: row!.msgFromId!, lte: row!.msgToId!, ...(beforeId !== null ? { lt: beforeId } : {}) } },
            orderBy: { messageId: 'desc' },
            take: FEED_LIMIT,
          });
          if (rows.length === FEED_LIMIT || row!.msgComplete || attempt === 1)
            return { messages: rows.map((r) => ({ ...withDelivery(r.dto as unknown as ChatMessageDto, r.mid), chatId, mid: r.mid })), more: rows.length === FEED_LIMIT || !row!.msgComplete };
          // Хранимого мало — догружаем старше диапазона и читаем снова.
          const older = await this.fetch(user.client, chatId, row!.msgFromId!);
          await this.store(portalId, chatId, older, row!.msgFromId!, FEED_LIMIT);
          continue;
        }
        if (beforeId !== null && row?.msgFromId != null && beforeId <= row.msgFromId) {
          // Старше диапазона: догружаем от его начала (страница примкнёт к диапазону).
          const older = await this.fetch(user.client, chatId, row.msgFromId);
          await this.store(portalId, chatId, older, row.msgFromId, FEED_LIMIT);
          if (row.msgFromId === beforeId || !(older.messages ?? []).length) continue;
        }
        break;
      }
    }
    const page = await this.fetch(user.client, chatId, beforeId);
    if (store) await this.store(portalId, chatId, page, beforeId, FEED_LIMIT);
    const raw = page.messages ?? [];
    return {
      messages: raw.map((m) => ({ ...toMessageDto(m, page.users ?? [], page.files ?? []), chatId, mid: connectorMidOf(m) })),
      more: raw.length >= FEED_LIMIT,
    };
  }

  private async fetch(client: Client, chatId: number, beforeId: number | null): Promise<ImPage> {
    return (await client.call<ImPage>('im.dialog.messages.get', { DIALOG_ID: `chat${chatId}`, LIMIT: FEED_LIMIT, ...(beforeId ? { LAST_ID: beforeId } : {}) })).result ?? {};
  }

  /** Реакции из мессенджера у сообщений своих линий (`btx24_*`): по `CONNECTOR_MID` и номеру линии. */
  private async withReactions(portalId: string, members: MemberChat[], messages: (FeedMessage & { mid?: string | null })[]): Promise<FeedMessage[]> {
    const strip = (m: FeedMessage & { mid?: string | null }): FeedMessage => {
      const { mid: _mid, ...rest } = m;
      return rest;
    };
    const lineOf = new Map(members.filter((m) => m.connector.startsWith('btx24_') && m.lineId && m.lineId > 0).map((m) => [m.chatId, m.lineId!]));
    const wanted = messages.filter((m) => m.mid && lineOf.has(m.chatId));
    if (!wanted.length) return messages.map(strip);
    const messengers = await this.prisma.messenger.findMany({ where: { portalId, lineMode: 'own', lineId: { in: [...new Set(lineOf.values())] } }, select: { id: true, lineId: true } });
    const byLine = new Map(messengers.map((m) => [m.lineId, m.id]));
    const rows = await this.prisma.messengerMessage.findMany({
      where: { portalId, messengerId: { in: messengers.map((m) => m.id) }, externalId: { in: [...new Set(wanted.map((m) => m.mid!))] } },
      select: { messengerId: true, externalId: true, reactions: true, ack: true },
    });
    const byMid = new Map(rows.map((r) => [`${r.messengerId}:${r.externalId}`, { reactions: groupReactions(r.reactions), ack: r.ack }]));
    return messages.map((m) => {
      const hit = m.mid ? byMid.get(`${byLine.get(lineOf.get(m.chatId) ?? -1)}:${m.mid}`) : undefined;
      if (!hit) return strip(m);
      const delivery = deliveryFromAck(m, hit.ack);
      return { ...strip(m), ...(hit.reactions.length ? { reactions: hit.reactions } : {}), ...(delivery ? { delivery } : {}) };
    });
  }
}
