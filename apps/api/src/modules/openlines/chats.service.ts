import { chatLineProblem, chatNotWorkingMessage } from './line-health.js';
import { clientPhoneVariants, messageChannel, todayIn, zonedDayRange } from '@btx24/shared';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { FAVORITES_FOLDER, hasTokens, renderMessage, TEMPLATE_VARIABLES, unresolvedTokens, type TemplateVariablesDto } from '@btx24/shared';
import type {
  ChatHistoryDto,
  ChatMessageDto,
  ChatListDto,
  ChatFlagDto,
  ChatReplyStatusDto,
  ChatChannelDto,
  AttentionChatDto,
  ChatScope,
  ChatSummary,
  DealChatsDto,
  MessageAuthorKind,
  SendResultDto,
  TemplateStepDto,
} from '@btx24/shared';
import { z } from 'zod';
import { reachedInChat, type CallClient, type ChatReach } from './call-stats.js';
import { selectedPeriod } from '../../common/period.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { bitrix24ErrorMessage } from '../bitrix24/http/bitrix24-error.filter.js';
import { Bitrix24Error, isClientGone } from '../bitrix24/rest/errors.js';
import {
  connectorMidOf,
  connectorOf,
  crmLinksOf,
  clientAvatarOf,
  groupReactions,
  lastMeaningful,
  messageText,
  preview,
  toMessageDto,
  type ImFile,
  type ImMessage,
  type ImUser,
} from './chat-parsing.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { dealOfBindings, PortalService } from '../bitrix24/portals/portal.service.js';
import { MessageContextService } from '../bookings/message-context.service.js';
import { FilesService } from './files.service.js';
import { OpenlineIndexService } from './openline-index.service.js';
import { stepsSchema } from './templates.service.js';

/** Сессия открытой линии в CRM (`crm.activity.list`, PROVIDER_ID = IMOPENLINES_SESSION). */
interface SessionActivity {
  ID: string;
  ASSOCIATED_ENTITY_ID: string;
  RESPONSIBLE_ID: string;
  COMPLETED: 'Y' | 'N';
  LAST_UPDATED: string;
  PROVIDER_PARAMS?: { USER_CODE?: string };
}

interface ImDialog {
  id: number;
  name?: string;
  role?: string;
  entity_id?: string;
  entity_data_2?: string;
}

interface ImMessages {
  messages?: ImMessage[];
  users?: ImUser[];
  files?: ImFile[];
}

/** Сессия для сводки: из дела CRM, из индекса или найденный по CRM чат (тогда `chatId`). */
interface SessionRef {
  sessionId: number;
  chatId?: number;
  responsibleId: number | null;
  completed: boolean;
  /** Дата из индекса — ключ сортировки (живая дата важнее, если новее). */
  indexedAt?: Date | null;
}

const HISTORY_LIMIT = 50;
/** Сколько найденных по номеру контактов / лидов / компаний каждого типа разбираем. */
const PHONE_MATCHES = 10;
/** Чатов в одной папке — больше не показываем. */
const MAX_FOLDER_CHATS = 100;
const PAGE = 50;
/** Счётчики непрочитанных сотрудника — не свежее опроса списка чатов. */
const UNREAD_TTL_MS = 10_000;
/** Сообщений на чат в сводке: среди них ищем последнее от клиента или оператора. */
const SUMMARY_MESSAGES = 20;
/** Кэш списка чатов: сводку старше этого сверяем с Битрикс24 в фоне (ответ — сразу из базы). */
const SUMMARY_STALE_MS = 30_000;
/** Доступ сотрудника к чату перепроверяем (его токеном) не реже этого. */
const ACCESS_STALE_MS = 5 * 60_000;
const listQuery = z
  .object({
    scope: z.enum(['mine', 'department', 'all']).default('all'),
    status: z.enum(['all', 'waiting', 'booked', 'payment']).optional(),
    channel: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    offset: z.coerce.number().int().min(0).default(0),
    /** Моя папка: только её чаты (без папки — общий список без чатов моих папок). */
    folder: z.string().min(1).max(40).optional(),
  })
  .strict();
const historyQuery = z.object({ beforeId: z.coerce.number().int().positive().optional() }).strict();
const sendBody = z.object({ steps: stepsSchema }).strict();

/**
 * Диалоги открытых линий **правами пользователя**. Список строится из сессий в CRM: REST не
 * отдаёт «все диалоги линии», а дела-сессии видны по правам CRM и несут ответственного, поэтому
 * их можно сузить до «мои» и «отдел». Дальше — `imopenlines.dialog.get` по сессии (чат, роль,
 * привязки CRM) и последние сообщения чата. Тексты не сохраняем — только показываем.
 */
@Injectable()
export class ChatsService {
  private readonly logger = new Logger(ChatsService.name);

  constructor(
    private readonly files: FilesService,
    private readonly index: OpenlineIndexService,
    private readonly prisma?: PrismaService,
    private readonly portals?: PortalService,
    private readonly messageContext?: MessageContextService,
  ) {}

  /**
   * Подставить переменные шаблона (`{{Поле сделки}}`, `{=Variable:…}`, `{client_name}`…) по сделке,
   * к которой сейчас привязан чат, — правами сотрудника. Нет сделки — тексты как есть.
   */
  /** Проверка шаблона на данных сделки (страница «Шаблоны»). */
  async preview(user: B24UserContext, body: unknown): Promise<{ texts: string[]; unresolved: string[] }> {
    const b = (body ?? {}) as { texts?: unknown; dealId?: unknown };
    const texts = b.texts;
    if (!Array.isArray(texts) || texts.length > 50 || texts.some((t) => typeof t !== 'string' || t.length > 4000))
      throw new BadRequestException({ code: 'INVALID_TEXTS', message: 'texts: до 50 строк до 4000 символов' });
    const dealId = Number(b.dealId);
    if (!Number.isInteger(dealId) || dealId <= 0) throw new BadRequestException({ code: 'INVALID_DEAL', message: 'Укажите номер сделки' });
    if (!this.messageContext) return { texts: texts as string[], unresolved: [] };
    const ctx = await this.messageContext.forDeal(user.portal, user.client, dealId);
    if (!ctx.deal) throw new BadRequestException({ code: 'DEAL_NOT_FOUND', message: `Сделка #${dealId} не найдена или нет доступа` });
    const out = (texts as string[]).map((t) => renderMessage(t, { ...ctx, vars: { ...ctx.vars, link: '{link}', prepayment: ctx.vars.prepayment ?? '' } }));
    return { texts: out, unresolved: [...new Set(out.flatMap(unresolvedTokens))].filter((t) => !['{link}', '{deadline}', '{minutes}', '{prepayment}'].includes(t)) };
  }

  async variables(user: B24UserContext): Promise<TemplateVariablesDto> {
    const t = this.messageContext ? await this.messageContext.titles(user.portal, user.client) : { deal: [], contact: [] };
    return {
      ...t,
      app: [
        ...Object.entries(TEMPLATE_VARIABLES).map(([k, label]) => ({ token: `{${k}}`, label })),
        { token: '{=Variable:programm}', label: 'программа по товарам сделки (как в БП)' },
        { token: '{=Variable:dealtype}', label: 'тип брони по товарам сделки' },
        { token: '{=Document:CONTACT.NAME}', label: 'имя контакта (как в БП)' },
        { token: '{=Document:UF_CRM_…}', label: 'поле сделки по коду (как в БП)' },
      ],
    };
  }

  async render(user: B24UserContext, chatId: number, body: unknown): Promise<{ texts: string[]; unresolved: string[]; dealId: number | null }> {
    const texts = (body as { texts?: unknown } | null)?.texts;
    if (!Array.isArray(texts) || texts.length > 50 || texts.some((t) => typeof t !== 'string' || t.length > 4000))
      throw new BadRequestException({ code: 'INVALID_TEXTS', message: 'texts: до 50 строк до 4000 символов' });
    if (!texts.some((t) => hasTokens(t as string)) || !this.messageContext) return { texts: texts as string[], unresolved: [], dealId: null };
    const dialog = (await user.client.call<{ entity_data_2?: string }>('imopenlines.dialog.get', { CHAT_ID: chatId })).result;
    const dealId = dealOfBindings(dialog?.entity_data_2);
    const ctx = await this.messageContext.forDeal(user.portal, user.client, dealId);
    const out = (texts as string[]).map((t) => renderMessage(t, ctx));
    return { texts: out, unresolved: [...new Set(out.flatMap(unresolvedTokens))], dealId };
  }

  /**
   * Файл сообщения чата (картинка, видео, документ) — через сервер приложения: прямые ссылки
   * портала во фрейме не открываются (нет входа в Битрикс24 у стороннего домена). Доступ к диалогу —
   * правами сотрудника; ссылку на файл берём его токеном, а если он не участник чата (видит диалог
   * по правам CRM), — токеном приложения.
   */
  async file(user: B24UserContext, chatId: number, fileId: number): Promise<{ data: Buffer; contentType: string | null }> {
    await user.client.call('imopenlines.dialog.get', { CHAT_ID: chatId });
    const params = { dialogId: `chat${chatId}`, fileId };
    try {
      const r = await user.client.call<{ downloadUrl?: string }>('im.v2.File.download', params);
      return await user.client.download(String(r.result?.downloadUrl ?? ''));
    } catch (err) {
      if (!(err instanceof Bitrix24Error) || !this.portals || err.code === 'FILE_TOO_LARGE') throw err;
      const app = this.portals.clientFor(user.portal);
      const r = await app.call<{ downloadUrl?: string }>('im.v2.File.download', params);
      return app.download(String(r.result?.downloadUrl ?? ''));
    }
  }

  /** Мои папки: чат → папка. */
  /**
   * Папка каждого чата для сотрудника: его папки, затем глобальные папки коллег (решение владельца
   * 2026-10-23) — своя папка важнее. Доступ к чату проверяется там, где строятся сводки.
   */
  async myFolders(user: B24UserContext): Promise<Map<number, string>> {
    if (!this.prisma) return new Map();
    const [mine, global] = await Promise.all([
      this.prisma.chatFolderItem.findMany({ where: { portalId: user.portal.id, ownerUserId: user.userId } }),
      this.prisma.chatFolderItem.findMany({ where: { portalId: user.portal.id, ownerUserId: { not: user.userId }, folder: { global: true } }, orderBy: { addedAt: 'asc' } }),
    ]);
    const out = new Map(mine.map((i) => [i.chatId, i.folderId]));
    for (const i of global) if (!out.has(i.chatId)) out.set(i.chatId, i.folderId);
    return out;
  }

  /** Избранные чаты сотрудника (★, личные). */
  async favorites(user: B24UserContext): Promise<Set<number>> {
    if (!this.prisma) return new Set();
    const rows = await this.prisma.chatFavorite.findMany({ where: { portalId: user.portal.id, userId: user.userId }, select: { chatId: true } });
    return new Set(rows.map((r) => r.chatId));
  }

  /**
   * Счётчики непрочитанных на сотрудника — на 10 секунд и одним запросом на всех одновременных: список
   * чатов, папки и каналы опрашиваются каждые 15 секунд, и каждый просил `im.recent.list` у портала.
   */
  private readonly unread = new Map<string, { value: Promise<Map<number, number>>; expiresAt: number }>();

  /** Непрочитанные по чатам открытых линий — личные счётчики мессенджера сотрудника. */
  async unreadByChat(user: B24UserContext): Promise<Map<number, number>> {
    const key = `${user.portal.id}:${user.userId}`;
    const hit = this.unread.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    if (this.unread.size > 2000) this.unread.clear();
    const value = this.fetchUnread(user);
    this.unread.set(key, { value, expiresAt: Date.now() + UNREAD_TTL_MS });
    // Ошибку не запоминаем: следующий запрос спросит портал снова.
    value.catch(() => this.unread.delete(key));
    return value;
  }

  /** Отметка прочитанного сотрудником — счётчики пересчитать при следующем запросе. */
  forgetUnread(user: B24UserContext): void {
    this.unread.delete(`${user.portal.id}:${user.userId}`);
  }

  private async fetchUnread(user: B24UserContext): Promise<Map<number, number>> {
    try {
      const out = new Map<number, number>();
      for (let offset = 0; offset < 2000; offset += 200) {
        const res = await user.client.call<{ items?: { id?: string | number; chat_id?: string | number; counter?: number }[]; hasMore?: boolean; hasMorePages?: boolean }>('im.recent.list', { UNREAD_ONLY: 'Y', SKIP_OPENLINES: 'N', LIMIT: 200, OFFSET: offset });
        const items = Array.isArray(res.result) ? res.result : res.result?.items ?? [];
        for (const i of items) {
          const chatId = Number(i.chat_id) || Number(String(i.id ?? '').replace(/^chat/, ''));
          if (chatId > 0 && Number(i.counter) > 0) out.set(chatId, Number(i.counter));
        }
        if (!res.result?.hasMore && !res.result?.hasMorePages) break;
        if (!items.length) break;
      }
      return out;
    } catch (err) {
      // Клиент ушёл — ошибка, а не «нет непрочитанных»: пустые счётчики попали бы в общий кэш.
      if (err instanceof Bitrix24Error && !isClientGone(err)) return new Map();
      throw err;
    }
  }

  /** Сводки чатов по их ID (папка, поиск): порядок — по последнему сообщению. */
  async summariesByChat(user: B24UserContext, chatIds: number[]): Promise<ChatSummary[]> {
    const indexed = await this.index.byChat(user.portal.id, chatIds);
    const refs = chatIds.map((chatId) => {
      const r = indexed.get(chatId);
      return { chatId, sessionId: r?.sessionId ?? 0, responsibleId: r?.responsibleId ?? null, completed: r?.completed ?? false, indexedAt: r?.lastMessageAt ?? null };
    });
    const cached = await this.cachedSummaries(user, refs);
    if (cached) return cached;
    return this.summaries(
      user,
      chatIds.map((chatId) => {
        const r = indexed.get(chatId);
        return {
          chatId,
          sessionId: r?.sessionId ?? 0,
          responsibleId: r?.responsibleId ?? null,
          completed: r?.completed ?? false,
          indexedAt: r?.lastMessageAt ?? null,
        };
      }),
    );
  }

  async list(user: B24UserContext, query: unknown): Promise<ChatListDto> {
    const parsed = listQuery.safeParse(query);
    if (!parsed.success)
      throw new BadRequestException({ code: 'INVALID_QUERY', message: 'Неверные параметры списка чатов' });
    if (parsed.data.status || parsed.data.channel) return this.filteredList(user, parsed.data);
    const { scope, offset, folder } = parsed.data;
    const folders = await this.myFolders(user);
    if (folder) {
      // «★ Избранное» — свои избранные (они остаются и в общем списке); папка — её чаты.
      const chatIds = folder === FAVORITES_FOLDER ? [...(await this.favorites(user))] : [...folders].filter(([, f]) => f === folder).map(([c]) => c);
      return { items: await this.summariesByChat(user, chatIds.slice(0, MAX_FOLDER_CHATS)), nextOffset: null, exactOrder: true };
    }
    // Чаты моих папок в общем списке не показываем — они в строках папок.
    const outside = (list: ChatSummary[]) => list.filter((c) => !folders.has(c.chatId));
    const responsible = await this.responsibleFilter(user, scope);
    if (responsible && !responsible.length) return { items: [], nextOffset: null, exactOrder: false };

    // Индекс (сбор метаданных включён): точный порядок по последнему сообщению, как в списке
    // диалогов Битрикс24. Видимость всё равно проверяется токеном пользователя в summaries().
    if (await this.index.isActive(user.portal.id)) {
      const rows = await this.index.page(user.portal.id, responsible, offset, PAGE);
      const refs = rows.map((r) => ({
        chatId: r.chatId,
        sessionId: r.sessionId,
        responsibleId: r.responsibleId,
        completed: r.completed,
        indexedAt: r.lastMessageAt,
      }));
      // Кэш: второй и следующие заходы — из базы; первый (холодный) — живьём, он же заполнит кэш.
      const items = (await this.cachedSummaries(user, refs)) ?? (await this.summaries(user, refs));
      return { items: outside(items), nextOffset: rows.length === PAGE ? offset + PAGE : null, exactOrder: true };
    }

    // Без индекса: дела CRM по дате изменения — порядок приблизительный (дело не обновляется
    // на каждое сообщение). Страница — 50 записей: столько же команд влезает в один batch.
    const res = await user.client.call<SessionActivity[]>('crm.activity.list', {
      filter: { PROVIDER_ID: 'IMOPENLINES_SESSION', ...(responsible ? { RESPONSIBLE_ID: responsible } : {}) },
      order: { LAST_UPDATED: 'DESC' },
      select: ['ID', 'ASSOCIATED_ENTITY_ID', 'RESPONSIBLE_ID', 'COMPLETED', 'LAST_UPDATED', 'PROVIDER_PARAMS'],
      start: offset,
    });
    // У одного клиента в чате бывает несколько сессий — берём самую свежую.
    const seen = new Set<string>();
    const sessions = (res.result ?? []).filter((a) => {
      const key = a.PROVIDER_PARAMS?.USER_CODE || `s${a.ASSOCIATED_ENTITY_ID}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return Number(a.ASSOCIATED_ENTITY_ID) > 0;
    });
    const items = await this.summaries(
      user,
      sessions.map((a) => ({
        sessionId: Number(a.ASSOCIATED_ENTITY_ID),
        responsibleId: Number(a.RESPONSIBLE_ID) || null,
        completed: a.COMPLETED === 'Y',
      })),
    );
    return { items: outside(items), nextOffset: res.next ?? null, exactOrder: false };
  }

  /** Сводки чатов для сессий: два пакетных запроса (диалоги, затем последние сообщения). */
  async summaries(user: B24UserContext, sessions: SessionRef[]): Promise<ChatSummary[]> {
    if (!sessions.length) return [];
    const dialogs = await user.client.batch(
      Object.fromEntries(
        sessions.map((s) => [
          refKey(s),
          { method: 'imopenlines.dialog.get', params: s.chatId ? { CHAT_ID: s.chatId } : { SESSION_ID: s.sessionId } },
        ]),
      ),
    );
    // Нет доступа к диалогу (ACCESS_ERROR) — такой чат пользователю не показываем.
    const pairs = sessions
      .map((s) => ({ s, d: dialogs.result[refKey(s)] as ImDialog | undefined }))
      .filter((x): x is { s: SessionRef; d: ImDialog } => Boolean(x.d?.id));
    const unique = [...new Map(pairs.map((x) => [x.d.id, x])).values()];
    if (!unique.length) return [];
    const [phones, unread, folders, marks, favorites] = await Promise.all([
      this.phonesOf(user, unique.map(({ d }) => crmLinksOf(d.entity_data_2))),
      this.unreadByChat(user),
      this.myFolders(user),
      this.noReplyMarks(user.portal.id, unique.map(({ d }) => Number(d.id))),
      this.favorites(user),
    ]);
    const msgs = await user.client.batch(
      Object.fromEntries(
        unique.map(({ d }) => [
          `c${d.id}`,
          { method: 'im.dialog.messages.get', params: { DIALOG_ID: `chat${d.id}`, LIMIT: SUMMARY_MESSAGES } },
        ]),
      ),
    );
    const summaries = unique.map(({ s, d }) => {
      const m = (msgs.result[`c${d.id}`] ?? {}) as ImMessages;
      const last = lastMeaningful(m.messages ?? [], m.users ?? []);
      const sessionClosed = s.completed;
      // Ключ сортировки — последнее сообщение клиента или оператора (живое или из индекса).
      const live = last?.human ? Date.parse(last.message.date) : 0;
      const sortKey = Math.max(live, s.indexedAt?.getTime() ?? 0);
      const summary: ChatSummary = {
        clientAvatar: m.users?.length ? clientAvatarOf(m.users, user.portal.domain) : null,
        chatId: Number(d.id),
        sessionId: s.sessionId,
        title: d.name ?? `Чат #${d.id}`,
        connector: connectorOf(d.entity_id),
        responsibleId: s.responsibleId,
        lastMessage: last
          ? {
              id: Number(last.message.id),
              date: new Date(last.message.date).toISOString(),
              author: last.kind,
              preview: preview(messageText(last.message.text)),
              hasFiles: Boolean(last.message.params?.FILE_ID?.length),
            }
          : null,
        waitingReply: isWaiting(sessionClosed, last?.human ? last.kind : null, last ? Number(last.message.id) : null, marks.get(Number(d.id)) ?? null),
        noReply: noReplyOf(marks.get(Number(d.id)) ?? null, last ? Number(last.message.id) : null),
        flag: flagOf(marks.get(Number(d.id)), last?.human ? last.kind : null, last?.human ? last.message.date : null),
        joined: isMember(d.role),
        sessionClosed,
        crm: crmLinksOf(d.entity_data_2),
        phones: phonesFor(crmLinksOf(d.entity_data_2), phones),
        clientName: clientNameFor(crmLinksOf(d.entity_data_2), phones) ?? clientFromTitle(d.name ?? null),
        // «Не требует ответа» обнуляет счётчик чата (решение владельца 2026-10-23).
        unread: noReplyOf(marks.get(Number(d.id)) ?? null, last ? Number(last.message.id) : null) ? 0 : (unread.get(Number(d.id)) ?? 0),
        folderId: folders.get(Number(d.id)) ?? null,
        favorite: favorites.has(Number(d.id)),
      };
      return { summary, sortKey, last, s, d, avatar: m.users?.length ? clientAvatarOf(m.users, user.portal.domain) : undefined };
    });
    await this.persist(
      user,
      summaries,
      sessions.filter((s) => s.chatId && !pairs.some((p) => p.s === s)).map((s) => s.chatId!),
    ).catch((e) => this.logger.warn(`chat cache write failed: ${e instanceof Error ? e.message : String(e)}`));
    return summaries.sort((a, b) => b.sortKey - a.sortKey).map((x) => x.summary);
  }

  /**
   * Кэш после живой загрузки: сводка чата — одна строка на чат (общая: чат, видимый двум
   * сотрудникам, хранится один раз), доступ — своя строка у каждого сотрудника. Чаты, к которым
   * Битрикс24 не пустил (`denied`), запоминаем как недоступные.
   */
  private async persist(
    user: B24UserContext,
    rows: { summary: ChatSummary; last: ReturnType<typeof lastMeaningful>; s: SessionRef; avatar?: string | null }[],
    denied: number[],
  ): Promise<void> {
    if (!this.prisma) return;
    const prisma = this.prisma;
    const portalId = user.portal.id;
    const texts = (await prisma.portalSettings.findUnique({ where: { portalId }, select: { dialogTextsEnabled: true } }))?.dialogTextsEnabled === true;
    const now = new Date();
    const ops = rows.flatMap(({ summary: c, last, s, avatar }) => {
      const summary = {
        title: c.title.slice(0, 255),
        clientName: c.clientName?.slice(0, 255) ?? null,
        ...(avatar !== undefined ? { clientAvatar: avatar } : {}),
        crm: c.crm as unknown as Prisma.InputJsonValue,
        phones: c.phones as unknown as Prisma.InputJsonValue,
        lastMessageId: c.lastMessage?.id ?? null,
        lastPreview: texts ? (c.lastMessage?.preview.slice(0, 500) ?? null) : null,
        lastHasFiles: c.lastMessage?.hasFiles ?? false,
        summaryAt: now,
        ...(last?.human ? { lastMessageAt: new Date(last.message.date), lastAuthor: last.kind, clientStreak: last.streak } : {}),
      };
      return [
        prisma.openlineChat.upsert({
          where: { portalId_chatId: { portalId, chatId: c.chatId } },
          // checkedAt — отметка прохода worker'а; живой запрос её не двигает (иначе worker пропустит изменения).
          create: { portalId, chatId: c.chatId, sessionId: s.sessionId, responsibleId: s.responsibleId, completed: s.completed, connector: c.connector.slice(0, 64), checkedAt: new Date(0), ...summary },
          update: summary,
        }),
        prisma.openlineChatAccess.upsert({
          where: { portalId_userId_chatId: { portalId, userId: user.userId, chatId: c.chatId } },
          create: { portalId, userId: user.userId, chatId: c.chatId, allowed: true, joined: c.joined, checkedAt: now },
          update: { allowed: true, joined: c.joined, checkedAt: now },
        }),
      ];
    });
    for (const chatId of denied)
      ops.push(
        prisma.openlineChatAccess.upsert({
          where: { portalId_userId_chatId: { portalId, userId: user.userId, chatId } },
          create: { portalId, userId: user.userId, chatId, allowed: false, checkedAt: now },
          update: { allowed: false, joined: false, checkedAt: now },
        }) as never,
      );
    if (ops.length) await prisma.$transaction(ops);
  }

  /**
   * Список из кэша — быстро: сводки чатов (общие) и доступы сотрудника (свои) из базы, вживую —
   * только непрочитанные. Нет сводки или доступа хоть у одного чата страницы — null (живая
   * загрузка заполнит кэш). Устаревшее сверяется с Битрикс24 в фоне, следующее обновление
   * списка уже свежее.
   */
  async cachedSummaries(user: B24UserContext, refs: SessionRef[]): Promise<ChatSummary[] | null> {
    if (!this.prisma || !refs.length || refs.some((r) => !r.chatId)) return null;
    const portalId = user.portal.id;
    const ids = refs.map((r) => r.chatId!);
    const [rows, access, settings] = await Promise.all([
      this.prisma.openlineChat.findMany({ where: { portalId, chatId: { in: ids } } }),
      this.prisma.openlineChatAccess.findMany({ where: { portalId, userId: user.userId, chatId: { in: ids } } }),
      this.prisma.portalSettings.findUnique({ where: { portalId }, select: { dialogTextsEnabled: true } }),
    ]);
    const byChat = new Map(rows.map((r) => [r.chatId, r]));
    const acc = new Map(access.map((a) => [a.chatId, a]));
    const texts = settings?.dialogTextsEnabled === true;
    const complete = ids.every((id) => {
      const r = byChat.get(id);
      const a = acc.get(id);
      if (!a) return false;
      if (!a.allowed) return true;
      return !!r?.summaryAt && r.title !== null && (!texts || r.lastMessageId === null || r.lastPreview !== null);
    });
    if (!complete) return null;

    const now = Date.now();
    const stale = ids.some((id) => {
      const r = byChat.get(id);
      const a = acc.get(id)!;
      return now - a.checkedAt.getTime() > ACCESS_STALE_MS || (a.allowed && now - (r?.summaryAt?.getTime() ?? 0) > SUMMARY_STALE_MS);
    });
    if (stale) this.revalidate(user, refs);

    const [unread, folders, favorites] = await Promise.all([this.unreadByChat(user), this.myFolders(user), this.favorites(user)]);
    return ids
      .filter((id) => acc.get(id)!.allowed && byChat.has(id))
      .map((id) => {
        const r = byChat.get(id)!;
        const crm = (r.crm as ChatSummary['crm'] | null) ?? { leadId: null, contactId: null, companyId: null, dealId: null };
        return {
          chatId: id,
          sessionId: r.sessionId,
          title: r.title ?? `Чат #${id}`,
          clientAvatar: r.clientAvatar ?? null,
          clientName: r.clientName ?? clientFromTitle(r.title),
          connector: r.connector,
          responsibleId: r.responsibleId,
          lastMessage:
            r.lastMessageId && r.lastMessageAt
              ? { id: r.lastMessageId, date: r.lastMessageAt.toISOString(), author: (r.lastAuthor ?? 'client') as MessageAuthorKind, preview: r.lastPreview ?? '', hasFiles: r.lastHasFiles }
              : null,
          waitingReply: isWaiting(r.completed, r.lastAuthor, r.lastMessageId, r),
          noReply: noReplyOf(r, r.lastMessageId),
          flag: flagOf(r, r.lastAuthor, r.lastMessageAt),
          joined: acc.get(id)!.joined,
          sessionClosed: r.completed,
          crm,
          phones: Array.isArray(r.phones) ? (r.phones as string[]) : [],
          unread: noReplyOf(r, r.lastMessageId) ? 0 : (unread.get(id) ?? 0),
          folderId: folders.get(id) ?? null,
          favorite: favorites.has(id),
        } satisfies ChatSummary;
      })
      .sort((a, b) => Date.parse(b.lastMessage?.date ?? '0') - Date.parse(a.lastMessage?.date ?? '0'));
  }

  private async touch(user: B24UserContext, chatId: number, dialog: ImDialog, messages: ImMessage[], users: ImUser[], joined: boolean): Promise<void> {
    if (!this.prisma) return;
    const row = await this.prisma.openlineChat.findUnique({ where: { portalId_chatId: { portalId: user.portal.id, chatId } } });
    const now = new Date();
    await this.prisma.openlineChatAccess.upsert({
      where: { portalId_userId_chatId: { portalId: user.portal.id, userId: user.userId, chatId } },
      create: { portalId: user.portal.id, userId: user.userId, chatId, allowed: true, joined, checkedAt: now },
      update: { allowed: true, joined, checkedAt: now },
    });
    if (!row) return; // строки нет — её создаст список или worker (нужна сессия)
    const last = lastMeaningful(messages, users);
    const texts = (await this.prisma.portalSettings.findUnique({ where: { portalId: user.portal.id }, select: { dialogTextsEnabled: true } }))?.dialogTextsEnabled === true;
    await this.prisma.openlineChat.update({
      where: { id: row.id },
      data: {
        title: (dialog.name ?? row.title ?? '').slice(0, 255) || null,
        crm: crmLinksOf(dialog.entity_data_2) as unknown as Prisma.InputJsonValue,
        ...(users.length ? { clientAvatar: clientAvatarOf(users, user.portal.domain) } : {}),
        ...(last
          ? {
              lastMessageId: Number(last.message.id),
              lastPreview: texts ? preview(messageText(last.message.text)).slice(0, 500) : null,
              lastHasFiles: Boolean(last.message.params?.FILE_ID?.length),
            }
          : {}),
        ...(last?.human ? { lastMessageAt: new Date(last.message.date), lastAuthor: last.kind, clientStreak: last.streak } : {}),
        summaryAt: now,
      },
    });
  }

  /** Фоновая сверка страницы с Битрикс24 (токеном сотрудника); одна на сотрудника и страницу. */
  private readonly revalidating = new Set<string>();
  private revalidate(user: B24UserContext, refs: SessionRef[]): void {
    const key = `${user.portal.id}:${user.userId}:${refs.map((r) => r.chatId).join(',')}`;
    if (this.revalidating.has(key)) return;
    this.revalidating.add(key);
    void this.summaries(user, refs)
      .catch((e) => this.logger.warn(`chat cache revalidate failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => this.revalidating.delete(key));
  }

  /**
   * Поиск чатов по номеру телефона клиента по всему порталу: CRM ищет контакты, лиды и компании
   * с этим номером (`crm.duplicate.findbycomm`, права пользователя), затем — их чаты открытых линий.
   */
  async searchByPhone(user: B24UserContext, query: unknown): Promise<ChatListDto> {
    const q = String((query as { q?: unknown } | null)?.q ?? '');
    const variants = phoneVariants(q);
    if (!variants.length)
      throw new BadRequestException({ code: 'INVALID_PHONE', message: 'Введите номер телефона полностью (не меньше 10 цифр)' });
    const found = await user.client.call<Partial<Record<'LEAD' | 'CONTACT' | 'COMPANY', number[]>>>('crm.duplicate.findbycomm', {
      type: 'PHONE',
      values: variants,
    });
    const entities = (['CONTACT', 'LEAD', 'COMPANY'] as const).flatMap((type) =>
      (found.result?.[type] ?? []).slice(0, PHONE_MATCHES).map((id) => ({ type, id: Number(id) })),
    );
    if (!entities.length) return { items: [], nextOffset: null, exactOrder: true };
    const chats = await user.client.batch(
      Object.fromEntries(
        entities.map((e) => [
          `${e.type}${e.id}`,
          { method: 'imopenlines.crm.chat.get', params: { CRM_ENTITY_TYPE: e.type.toLowerCase(), CRM_ENTITY: e.id, ACTIVE_ONLY: 'N' } },
        ]),
      ),
    );
    const chatIds = [
      ...new Set(
        entities.flatMap((e) =>
          ((chats.result[`${e.type}${e.id}`] as { CHAT_ID?: string | number }[] | undefined) ?? []).map((c) => Number(c.CHAT_ID)),
        ),
      ),
    ].filter((id) => id > 0);
    const items = await this.summariesByChat(user, chatIds.slice(0, PAGE));
    return { items, nextOffset: null, exactOrder: true };
  }

  /**
   * Чаты сделки и её клиента (контакты сделки) — вкладка с именем клиента во встройке сделки. Чаты
   * ищет портал правами сотрудника (`imopenlines.crm.chat.get`), как поиск по номеру.
   */
  async byDeal(user: B24UserContext, dealId: number): Promise<DealChatsDto> {
    const deal = (await user.client.call<{ ID?: string; CONTACT_ID?: string | null }>('crm.deal.get', { id: dealId })).result;
    if (!deal?.ID) throw new NotFoundException({ code: 'DEAL_NOT_FOUND', message: `Сделка #${dealId} не найдена` });
    const items = (await user.client.call<{ CONTACT_ID?: string | number }[]>('crm.deal.contact.items.get', { id: dealId })).result ?? [];
    const contactIds = [...new Set([Number(deal.CONTACT_ID), ...items.map((c) => Number(c.CONTACT_ID))].filter((x) => x > 0))].slice(0, PHONE_MATCHES);
    const entities = [{ type: 'deal', id: dealId }, ...contactIds.map((id) => ({ type: 'contact', id }))];
    const res = await user.client.batch({
      ...Object.fromEntries(entities.map((e) => [`${e.type}${e.id}`, { method: 'imopenlines.crm.chat.get', params: { CRM_ENTITY_TYPE: e.type, CRM_ENTITY: e.id, ACTIVE_ONLY: 'N' } }])),
      ...(contactIds.length ? { contact: { method: 'crm.contact.get', params: { id: contactIds[0] } } } : {}),
    });
    const chatIds = [
      ...new Set(entities.flatMap((e) => ((res.result[`${e.type}${e.id}`] as { CHAT_ID?: string | number }[] | undefined) ?? []).map((c) => Number(c.CHAT_ID)))),
    ].filter((id) => id > 0);
    const contact = res.result.contact as { NAME?: string | null; LAST_NAME?: string | null } | undefined;
    const clientName = contact ? [contact.NAME, contact.LAST_NAME].filter(Boolean).join(' ').trim() || null : null;
    const chats = chatIds.length ? await this.summariesByChat(user, chatIds.slice(0, PAGE)) : [];
    // Встройка решает, открыть чат или предложить новый: рабочая ли линия у каждого чата.
    const problems = await Promise.all(chats.map((c) => chatLineProblem(user.client, this.prisma, user.portal.id, c.chatId)));
    return { clientName, items: chats.map((c, i) => ({ ...c, lineProblem: problems[i] })) };
  }

  /** Телефоны привязанных контактов, лидов и компаний — одним пакетом, правами пользователя. */
  /** Телефоны (для поиска) и имена клиентов привязок CRM — одним пакетом; ключ `contact:12`. */
  private async phonesOf(user: B24UserContext, links: ChatSummary['crm'][]): Promise<Map<string, string[]>> {
    const ids = {
      contact: [...new Set(links.map((l) => l.contactId).filter((x): x is number => !!x))],
      lead: [...new Set(links.map((l) => l.leadId).filter((x): x is number => !!x))],
      company: [...new Set(links.map((l) => l.companyId).filter((x): x is number => !!x))],
    };
    const commands = Object.fromEntries(
      (Object.keys(ids) as (keyof typeof ids)[])
        .filter((k) => ids[k].length)
        .map((k) => [k, { method: `crm.${k}.list`, params: { filter: { '@ID': ids[k] }, select: ['ID', 'PHONE', 'NAME', 'LAST_NAME', 'TITLE'] } }]),
    );
    const out = new Map<string, string[]>();
    if (!Object.keys(commands).length) return out;
    try {
      const res = await user.client.batch(commands);
      for (const k of Object.keys(commands)) {
        for (const row of (res.result[k] as { ID: string; PHONE?: { VALUE?: string }[]; NAME?: string | null; LAST_NAME?: string | null; TITLE?: string | null }[] | undefined) ?? []) {
          out.set(`${k}:${row.ID}`, (row.PHONE ?? []).map((p) => String(p.VALUE ?? '')).filter(Boolean));
          // Имя: у контакта и лида — имя и фамилия, у компании (и лида без имени) — название.
          const name = (k === 'company' ? '' : [row.NAME, row.LAST_NAME].filter(Boolean).join(' ').trim()) || (row.TITLE ?? '').trim();
          if (name) out.set(`name:${k}:${row.ID}`, [name]);
        }
      }
    } catch (err) {
      // Телефоны — только для поиска: без них список всё равно показываем.
      if (!(err instanceof Bitrix24Error)) throw err;
    }
    return out;
  }

  async history(user: B24UserContext, chatId: number, query: unknown, canSendRight: boolean): Promise<ChatHistoryDto> {
    const parsed = historyQuery.safeParse(query);
    if (!parsed.success)
      throw new BadRequestException({ code: 'INVALID_QUERY', message: 'Неверный параметр beforeId' });
    // Диалог (права, роль) и сообщения — одним пакетом: переписка опрашивается, лимит портала — на запросы.
    const pack = await user.client.batch({
      dialog: { method: 'imopenlines.dialog.get', params: { CHAT_ID: chatId } },
      messages: { method: 'im.dialog.messages.get', params: { DIALOG_ID: `chat${chatId}`, LIMIT: HISTORY_LIMIT, ...(parsed.data.beforeId ? { LAST_ID: parsed.data.beforeId } : {}) } },
    });
    const failed = (pack.errors as Record<string, { error?: string; error_description?: string } | undefined>).dialog ?? (pack.errors as Record<string, { error?: string; error_description?: string } | undefined>).messages;
    if (failed) throw new Bitrix24Error(String(failed.error ?? 'ERROR'), failed.error_description ?? String(failed.error ?? 'ERROR'), undefined, { method: 'imopenlines.dialog.get' });
    const dialog = pack.result.dialog as ImDialog;
    const res = { result: pack.result.messages as ImMessages | undefined };
    const users = res.result?.users ?? [];
    const files = res.result?.files ?? [];
    const raw = res.result?.messages ?? [];
    const joined = isMember(dialog.role);
    // Открытая переписка — самые свежие данные: обновляем строку чата в кэше списка (например,
    // после ответа чат сразу уходит из «Ждут ответа»), и свой доступ.
    if (!parsed.data.beforeId) await this.touch(user, chatId, dialog, raw, users, joined).catch(() => undefined);
    return {
      chatId,
      title: dialog.name ?? `Чат #${chatId}`,
      connector: connectorOf(dialog.entity_id),
      joined,
      canSend: joined && canSendRight,
      crm: crmLinksOf(dialog.entity_data_2),
      messages: await this.withReactions(user.portal.id, dialog.entity_id, raw, raw.map((m) => toMessageDto(m, users, files)).sort((a, b) => a.id - b.id)),
      hasMore: raw.length >= HISTORY_LIMIT,
    };
  }

  /**
   * Реакции из мессенджера — у чатов своих линий приложения (`btx24_*`): сообщение линии связано с
   * перепиской приложения через `CONNECTOR_MID`, номер — по линии чата (`entity_id`).
   */
  private async withReactions(portalId: string, entityId: string | null | undefined, raw: ImMessage[], messages: ChatMessageDto[]): Promise<ChatMessageDto[]> {
    const [connector, line] = String(entityId ?? '').split('|');
    if (!this.prisma || !connector?.startsWith('btx24_') || !Number(line)) return messages;
    const mids = new Map<number, string>();
    for (const m of raw) {
      const mid = connectorMidOf(m);
      if (mid) mids.set(Number(m.id), mid);
    }
    if (!mids.size) return messages;
    const messenger = await this.prisma.messenger.findFirst({ where: { portalId, lineMode: 'own', lineId: Number(line) }, select: { id: true } });
    if (!messenger) return messages;
    const rows = await this.prisma.messengerMessage.findMany({ where: { portalId, messengerId: messenger.id, externalId: { in: [...new Set(mids.values())] } }, select: { externalId: true, reactions: true } });
    const byMid = new Map(rows.map((r) => [r.externalId, groupReactions(r.reactions)]));
    return messages.map((m) => {
      const reactions = byMid.get(mids.get(m.id) ?? '');
      return reactions?.length ? { ...m, reactions } : m;
    });
  }

  /** Войти в диалог оператором (`imopenlines.session.join`). В режиме «только чтение» запрещено. */
  /**
   * Ждут ответа среди всех доступных сотруднику чатов (кэш: сводки общие, доступ — его) и самые
   * свежие из них — «требуют внимания» на дашборде.
   */
  /** Одна область доступных чатов для счётчиков дашборда и вкладок, включая обычные папки. */
  private async population(user: B24UserContext, query: { from?: unknown; to?: unknown } = {}) {
    const period = selectedPeriod(query, user.portal.timezone);
    if (!this.prisma) return { rows: [], ignored: new Set<number>() };
    const portalId = user.portal.id;
    const [allowed, ignored] = await Promise.all([
      this.prisma.openlineChatAccess.findMany({ where: { portalId, userId: user.userId, allowed: true }, select: { chatId: true } }),
      this.prisma.chatFolderItem.findMany({ where: { portalId, folder: { ignoreAttention: true }, OR: [{ ownerUserId: user.userId }, { folder: { global: true } }] }, select: { chatId: true } }),
    ]);
    const rows = allowed.length ? await this.prisma.openlineChat.findMany({
      where: { portalId, chatId: { in: allowed.map((a) => a.chatId) }, ...(period ? { lastMessageAt: { gte: period.start, lt: period.end } } : {}) },
      orderBy: [{ lastMessageAt: 'desc' }, { chatId: 'desc' }],
    }) : [];
    return { rows, ignored: new Set(ignored.map((r) => r.chatId)) };
  }

  /**
   * Чаты клиентов со сделками из `dealIds`: сделка чата — из них, или контакт чата — клиент этих сделок
   * (контакт сделки — из копии CRM).
   */
  private async clientsOfDeals(portalId: string, dealIds: number[]): Promise<(r: { crm: unknown }) => boolean> {
    const deals = new Set(dealIds);
    const contacts = new Set<number>();
    if (deals.size && this.prisma)
      for (const d of await this.prisma.crmDeal.findMany({ where: { portalId, dealId: { in: [...deals] }, deletedAt: null }, select: { contactId: true } }))
        if (d.contactId) contacts.add(d.contactId);
    return (r) => {
      const crm = (r.crm as ChatSummary['crm'] | null) ?? null;
      return (!!crm?.dealId && deals.has(crm.dealId)) || (!!crm?.contactId && contacts.has(crm.contactId));
    };
  }

  /** Сделки с активной бронью на сегодня (журнал приложения, день — в часовом поясе портала). */
  private async bookedTodayDeals(user: B24UserContext): Promise<number[]> {
    if (!this.prisma) return [];
    const { start, end } = zonedDayRange(todayIn(user.portal.timezone), user.portal.timezone);
    const rows = await this.prisma.bookingRecord.findMany({ where: { portalId: user.portal.id, status: 'active', dealId: { not: null }, startsAt: { lt: end }, endsAt: { gt: start } }, select: { dealId: true } });
    return [...new Set(rows.map((r) => r.dealId!))];
  }

  /** Сделки, где ждём оплату: счёт выставлен (ссылка готовится или отправлена), не оплачен и не закрыт. */
  private async awaitingPaymentDeals(user: B24UserContext): Promise<number[]> {
    if (!this.prisma) return [];
    const rows = await this.prisma.paymentRequest.findMany({ where: { portalId: user.portal.id, status: { in: ['link_pending', 'sent'] }, closedAt: null }, select: { dealId: true } });
    return [...new Set(rows.map((r) => r.dealId))];
  }

  private async filteredList(user: B24UserContext, q: { scope: ChatScope; status?: 'all' | 'waiting' | 'booked' | 'payment'; channel?: string; offset: number; folder?: string; from?: string; to?: string }): Promise<ChatListDto> {
    // Первая обычная страница прогревает доступ и метаданные при холодном входе.
    const legacy = await this.list(user, { scope: q.scope, offset: q.status && q.status !== 'all' ? 0 : q.offset, ...(q.folder ? { folder: q.folder } : {}) });
    const population = await this.population(user, q);
    if (!this.prisma) return { ...legacy, counts: { all: legacy.items.length, waiting: legacy.items.filter((c) => c.waitingReply).length, mine: legacy.items.filter((c) => c.responsibleId === user.userId).length }, userId: user.userId };
    const folders = await this.myFolders(user);
    const favorite = q.folder === FAVORITES_FOLDER ? await this.favorites(user) : null;
    const channels = [...new Set(population.rows.map(r => messageChannel(r.connector)))].sort();
    const rows = population.rows.filter(r => !q.channel || messageChannel(r.connector) === q.channel).filter((r) => !q.folder || (favorite ? favorite.has(r.chatId) : folders.get(r.chatId) === q.folder));
    const waiting = rows.filter((r) => (q.folder || !population.ignored.has(r.chatId)) && isWaiting(r.completed, r.lastAuthor, r.lastMessageId, r));
    const [isBooked, awaitsPayment] = await Promise.all([
      this.bookedTodayDeals(user).then((ids) => this.clientsOfDeals(user.portal.id, ids)),
      this.awaitingPaymentDeals(user).then((ids) => this.clientsOfDeals(user.portal.id, ids)),
    ]);
    const booked = rows.filter(isBooked);
    const payment = rows.filter(awaitsPayment);
    const counts = { all: rows.length, waiting: waiting.length, mine: rows.filter((r) => r.responsibleId === user.userId).length, booked: booked.length, payment: payment.length };
    const byStatus = q.status === 'waiting' ? waiting : q.status === 'booked' ? booked : q.status === 'payment' ? payment : rows;
    const candidates = byStatus.filter((r) => q.scope !== 'mine' || r.responsibleId === user.userId);
    // Фильтр применяем до пагинации. Вкладки ожидания, броней, оплат и Мои включают чаты обычных папок.
    const selected = (q.status && q.status !== 'all') || q.scope === 'mine' || q.from || q.folder
      ? candidates
      : candidates.filter((r) => !folders.has(r.chatId));
    const ids = selected.slice(q.offset, q.offset + PAGE).map((r) => r.chatId);
    const items = await this.summariesByChat(user, ids);
    return { items, nextOffset: q.offset + PAGE < selected.length ? q.offset + PAGE : null, exactOrder: true, counts, userId: user.userId, channels };
  }

  /** После пропущенного была переписка с сотрудником; последнее сообщение может быть клиентским. */
  async reachedSince(user: B24UserContext, since: Date, clients: CallClient[]): Promise<ChatReach[]> {
    if (!this.prisma || !clients.length) return [];
    const population = await this.population(user);
    const rows = population.rows.filter((r) => r.lastMessageAt && r.lastMessageAt >= since).map((r) => ({ chatId: r.chatId, contactId: Number((r.crm as { contactId?: number } | null)?.contactId) || null, reachPhones: (Array.isArray(r.phones) ? r.phones as string[] : []).map((p) => String(p).replace(/\D/g, '').slice(-10)) })).filter((r) => clients.some((c) => reachedInChat(c, [{ contactId: r.contactId, phones: r.reachPhones, at: Number.MAX_SAFE_INTEGER }])));
    // Новый сотрудник мог ещё не открывать список: чаты контакта проверяем его REST-клиентом.
    for (const c of clients) {
      if (!c.contactId || rows.some((r) => r.contactId === c.contactId)) continue;
      try {
        const found = (await user.client.call<{ CHAT_ID: string }[]>('imopenlines.crm.chat.get', { CRM_ENTITY_TYPE: 'contact', CRM_ENTITY: c.contactId, ACTIVE_ONLY: 'N' })).result;
        for (const item of Array.isArray(found) ? found : []) {
          const chatId = Number(item.CHAT_ID);
          if (!(chatId > 0) || rows.some((r) => r.chatId === chatId)) continue;
          const dialog = (await user.client.call<ImDialog>('imopenlines.dialog.get', { CHAT_ID: chatId })).result;
          if (crmLinksOf(dialog?.entity_data_2).contactId !== c.contactId) continue;
          rows.push({ chatId, contactId: c.contactId, reachPhones: [] });
        }
      } catch { /* Без доступа — не считаем диалог доказанным. */ }
    }
    if (!rows.length) return [];
    const marks = await this.prisma.systemMessage.findMany({ where: { portalId: user.portal.id, chatId: { in: rows.map((r) => r.chatId) }, sentAt: { gte: since } }, select: { chatId: true, messageId: true } });
    const system = new Set(marks.map((r) => `${r.chatId}:${r.messageId}`));
    const reached = await Promise.all(rows.map(async (row): Promise<ChatReach | null> => {
      try {
        let before: number | undefined;
        // Метаданные, без хранения/выдачи текста. Ищем ответ даже если последним снова написал клиент.
        for (let page = 0; page < 10; page++) {
          const r = (await user.client.call<ImMessages>('im.dialog.messages.get', { DIALOG_ID: `chat${row.chatId}`, LIMIT: HISTORY_LIMIT, ...(before ? { LAST_ID: before } : {}) })).result ?? {};
          const messages = r.messages ?? [];
          if (!messages.length) break;
          const at = Math.max(0, ...messages.filter((m) => !system.has(`${row.chatId}:${m.id}`)).map((m) => toMessageDto(m, r.users ?? [], [])).filter((m) => m.viaPhone || (m.author.kind === 'employee' && (r.users ?? []).some((u) => Number(u.id) === m.author.id && !u.connector && !u.bot))).map((m) => Date.parse(m.date)));
          if (at > since.getTime()) return { contactId: row.contactId, phones: row.reachPhones, at };
          if (messages.length < HISTORY_LIMIT || messages.some((m) => Date.parse(m.date) <= since.getTime())) break;
          const next = Math.min(...messages.map((m) => Number(m.id)));
          if (next === before) break;
          before = next;
        }
      } catch { /* Нет доступа/истории — не выдаём общение за состоявшееся. */ }
      return null;
    }));
    return reached.filter((r): r is ChatReach => r !== null);
  }

  async attention(user: B24UserContext, limit = 50, query: { from?: unknown; to?: unknown } = {}): Promise<{ waiting: number; items: AttentionChatDto[] }> {
    if (!this.prisma) return { waiting: 0, items: [] };
    const population = await this.population(user, query);
    const hidden = await this.prisma.dashboardHiddenChat.findMany({ where: { portalId: user.portal.id, userId: user.userId }, select: { chatId: true } });
    const skip = new Set(hidden.map((r) => r.chatId));
    const waiting = population.rows.filter((r) => !population.ignored.has(r.chatId) && isWaiting(r.completed, r.lastAuthor, r.lastMessageId, r));
    // «!» — первыми и даже без ожидания ответа (отметку видят все, пока сотрудник не напишет).
    const flagged = population.rows.filter((r) => flagOf(r, r.lastAuthor, r.lastMessageAt));
    const shown = [...flagged, ...waiting.filter((r) => !flagged.includes(r))];
    const unread = shown.length ? await this.unreadByChat(user) : new Map<number, number>();
    return {
      waiting: waiting.length,
      items: shown.filter((r) => !skip.has(r.chatId)).slice(0, limit).map((r) => {
        const crm = (r.crm as ChatSummary['crm'] | null) ?? null;
        return {
          chatId: r.chatId,
          // Личный счётчик мессенджера есть только у участника чата — иначе сообщения клиента без ответа.
          unread: Math.max(unread.get(r.chatId) ?? 0, r.clientStreak ?? 0),
          title: r.title ?? `Чат #${r.chatId}`,
          clientName: r.clientName ?? clientFromTitle(r.title),
          clientAvatar: r.clientAvatar,
          connector: r.connector,
          lastMessageAt: (r.lastMessageAt ?? r.checkedAt).toISOString(),
          preview: r.lastPreview ?? '',
          hasFiles: r.lastHasFiles,
          dealId: crm?.dealId ?? null,
          contactId: crm?.contactId ?? null,
          responsibleId: r.responsibleId,
          flag: flagOf(r, r.lastAuthor, r.lastMessageAt),
        };
      }),
    };
  }

  /**
   * «!» у чата — общая отметка для всех сотрудников (решение владельца 2026-10-25). Снимается сама,
   * когда после неё в чат пишет сотрудник; вручную — `on: false`. Доступ к чату проверяется токеном
   * сотрудника (`imopenlines.dialog.get`).
   */
  async setFlag(user: B24UserContext, chatId: number, body: unknown): Promise<ChatFlagDto> {
    const on = (body as { on?: unknown } | null)?.on;
    if (typeof on !== 'boolean') throw new BadRequestException({ code: 'INVALID_FLAG', message: 'Ожидается { on: true | false }' });
    if (!this.prisma) throw new BadRequestException({ code: 'NO_CACHE', message: 'Кэш чатов недоступен' });
    const dialog = (await user.client.call<{ id?: number }>('imopenlines.dialog.get', { CHAT_ID: chatId })).result;
    if (!dialog?.id) throw new NotFoundException({ code: 'CHAT_NOT_FOUND', message: 'Чат недоступен' });
    const row = await this.prisma.openlineChat.findUnique({ where: { portalId_chatId: { portalId: user.portal.id, chatId } } });
    if (!row) throw new NotFoundException({ code: 'CHAT_NOT_CACHED', message: 'Чат ещё не загружен в список — обновите список чатов' });
    const updated = await this.prisma.openlineChat.update({
      where: { id: row.id },
      data: on ? { flagAt: new Date(), flagByUserId: user.userId, flagByName: user.userName.slice(0, 255) } : { flagAt: null, flagByUserId: null, flagByName: null },
    });
    return { chatId, flag: flagOf(updated, updated.lastAuthor, updated.lastMessageAt) ?? null };
  }

  /** Скрыть чат с моего дашборда (решение владельца 2026-10-23): в списке чатов он остаётся. */
  async hideFromDashboard(user: B24UserContext, chatId: number): Promise<void> {
    if (!this.prisma) return;
    const portalId = user.portal.id;
    await this.prisma.dashboardHiddenChat.upsert({
      where: { portalId_userId_chatId: { portalId, userId: user.userId, chatId } },
      create: { portalId, userId: user.userId, chatId, hiddenAt: new Date() },
      update: {},
    });
  }

  /**
   * Каналы клиента: у контакта может быть несколько открытых линий (WhatsApp, Telegram…) — у каждой
   * свой чат. Чаты того же контакта из кэша, кроме явно недоступных сотруднику (открытие чата всё
   * равно проверит доступ его токеном).
   */
  async channels(user: B24UserContext, chatId: number): Promise<ChatChannelDto[]> {
    if (!this.prisma) return [];
    const portalId = user.portal.id;
    const me = await this.prisma.openlineChat.findUnique({ where: { portalId_chatId: { portalId, chatId } }, select: { crm: true } });
    const contactId = (me?.crm as ChatSummary['crm'] | null)?.contactId ?? null;
    const current = await this.summariesByChat(user, [chatId]);
    if (!current.length) return [];
    const rows = await this.prisma.openlineChat.findMany({ where: { portalId }, orderBy: { lastMessageAt: 'desc' }, take: 5000 });
    const linked = await this.prisma.messengerMessage.findFirst({ where: { portalId, b24ChatId: chatId }, select: { messengerId: true, chatId: true } });
    const siblingRows = linked ? await this.prisma.messengerMessage.findMany({ where: { portalId, messengerId: linked.messengerId, chatId: linked.chatId, b24ChatId: { not: null } }, select: { b24ChatId: true }, distinct: ['b24ChatId'] }) : [];
    const siblings = new Set(siblingRows.map(r => r.b24ChatId));
    const candidates = rows.filter(r => (!!contactId && (r.crm as ChatSummary['crm'] | null)?.contactId === contactId) || siblings.has(r.chatId));
    const allowed = await this.summariesByChat(user, candidates.map(r => r.chatId));
    return allowed.map(r => ({
      chatId: r.chatId, connector: r.connector, title: r.title, lastMessageAt: r.lastMessage?.date ?? null, waitingReply: r.waitingReply,
      clientName: r.clientName, clientAvatar: r.clientAvatar ?? null, preview: r.lastMessage?.preview ?? '', hasFiles: r.lastMessage?.hasFiles ?? false, unread: r.unread ?? 0, dealId: r.crm?.dealId ?? null,
    }));
  }

  /** Отметки «Не требует ответа» чатов (общие для всех сотрудников). */
  private async noReplyMarks(portalId: string, chatIds: number[]): Promise<Map<number, NoReplyMark & FlagMark>> {
    if (!this.prisma || !chatIds.length) return new Map();
    const rows = await this.prisma.openlineChat.findMany({
      where: { portalId, chatId: { in: chatIds }, OR: [{ noReplyMessageId: { not: null } }, { flagAt: { not: null } }] },
      select: { chatId: true, noReplyMessageId: true, noReplyByName: true, noReplyAt: true, flagAt: true, flagByName: true },
    });
    return new Map(rows.map((r) => [r.chatId, r]));
  }

  /**
   * «Не требует ответа» / снова «ждёт ответа» — одна отметка для всех сотрудников (решение владельца
   * 2026-10-22). Привязана к последнему сообщению клиента: новое сообщение клиента снова «ждёт ответа».
   * Последнее сообщение читается токеном сотрудника — заодно проверка, что чат ему доступен.
   */
  async setReplyStatus(user: B24UserContext, chatId: number, body: unknown): Promise<ChatReplyStatusDto> {
    const needed = (body as { needed?: unknown } | null)?.needed;
    if (typeof needed !== 'boolean') throw new BadRequestException({ code: 'INVALID_REPLY_STATUS', message: 'Ожидается { needed: true | false }' });
    if (!this.prisma) throw new BadRequestException({ code: 'NO_CACHE', message: 'Кэш чатов недоступен' });
    const m = (await user.client.call<ImMessages>('im.dialog.messages.get', { DIALOG_ID: `chat${chatId}`, LIMIT: SUMMARY_MESSAGES })).result ?? {};
    const last = lastMeaningful(m.messages ?? [], m.users ?? []);
    const lastId = last ? Number(last.message.id) : null;
    const row = await this.prisma.openlineChat.findUnique({ where: { portalId_chatId: { portalId: user.portal.id, chatId } } });
    if (!row) throw new NotFoundException({ code: 'CHAT_NOT_CACHED', message: 'Чат ещё не загружен в список — обновите список чатов' });
    const mark = needed
      ? { noReplyMessageId: null, noReplyByUserId: null, noReplyByName: null, noReplyAt: null }
      : { noReplyMessageId: lastId ?? 0, noReplyByUserId: user.userId, noReplyByName: user.userName.slice(0, 255), noReplyAt: new Date() };
    const updated = await this.prisma.openlineChat.update({
      where: { id: row.id },
      data: { ...mark, ...(last?.human ? { lastMessageId: lastId, lastMessageAt: new Date(last.message.date), lastAuthor: last.kind, clientStreak: last.streak } : {}) },
    });
    // Счётчик непрочитанных у отметившего — в ноль и в мессенджере (у остальных его скрывает отметка).
    if (!needed) {
      await user.client.call('im.dialog.read', { DIALOG_ID: `chat${chatId}` }).catch(() => undefined);
      this.forgetUnread(user);
    }
    return {
      chatId,
      waitingReply: isWaiting(updated.completed, updated.lastAuthor, updated.lastMessageId, updated),
      noReply: noReplyOf(updated, updated.lastMessageId),
    };
  }

  async join(user: B24UserContext, chatId: number): Promise<void> {
    await user.client.call('imopenlines.session.join', { CHAT_ID: chatId });
  }

  /** Пауза между сообщениями цепочки: каналы (WhatsApp через Wazzup и др.) доставляют асинхронно. */
  sendGapMs = 1500;
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  /**
   * Цепочка сообщений по порядку. У шага сначала текст (`im.message.add`), потом каждый файл
   * отдельным сообщением (`im.v2.File.upload`, поля `fields.name/content` — вложенный `FILE` портал
   * отвергает как FILE_EMPTY). Между сообщениями — пауза: иначе канал может доставить клиенту
   * второе раньше первого. На ошибке останавливаемся и сообщаем, сколько шагов ушло: повтор
   * отправит только оставшиеся (интерфейс убирает отправленные).
   */
  async send(user: B24UserContext, chatId: number, body: unknown): Promise<SendResultDto> {
    const parsed = sendBody.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException({ code: 'INVALID_CHAIN', message: 'Цепочка пуста или шаг без текста и вложений' });
    const steps: TemplateStepDto[] = parsed.data.steps;
    // Только через рабочую открытую линию (решение владельца 2026-10-26).
    const problem = await chatLineProblem(user.client, this.prisma, user.portal.id, chatId);
    if (problem) throw new ConflictException({ code: 'CHAT_NOT_WORKING', message: chatNotWorkingMessage(problem) });
    const files = await this.files.loadOwned(user, [...new Set(steps.flatMap((s) => s.fileIds))]);
    const dialogId = `chat${chatId}`;
    const messageIds: number[] = [];
    let first = true;
    const gap = async () => {
      if (!first && this.sendGapMs > 0) await this.sleep(this.sendGapMs);
      first = false;
    };
    for (const [i, step] of steps.entries()) {
      try {
        if (step.text.trim()) {
          await gap();
          const res = await user.client.call<number>('im.message.add', { DIALOG_ID: dialogId, MESSAGE: step.text });
          messageIds.push(Number(res.result));
        }
        for (const id of step.fileIds) {
          const f = files.get(id)!;
          await gap();
          const res = await user.client.call<{ messageId?: number }>('im.v2.File.upload', {
            dialogId,
            fields: { name: f.name, content: f.data.toString('base64') },
          });
          messageIds.push(Number(res.result?.messageId ?? 0));
        }
      } catch (err) {
        if (!(err instanceof Bitrix24Error)) throw err;
        return { sent: i, messageIds, error: { step: i, code: err.code, message: bitrix24ErrorMessage(err) } };
      }
    }
    await this.files.dropUnused(user, [...files.keys()]);
    return { sent: steps.length, messageIds, error: null };
  }

  /** null — без фильтра (все доступные по CRM); [] — фильтр, под который никто не попал. */
  private async responsibleFilter(user: B24UserContext, scope: ChatScope): Promise<number[] | null> {
    if (scope === 'all') return null;
    if (scope === 'mine') return [user.userId];
    const departments = await this.departmentWithChildren(user);
    if (!departments.length) return [user.userId];
    const rows = await user.client.listAll<{ ID: string }>('user.get', {
      FILTER: { UF_DEPARTMENT: departments, ACTIVE: true },
    });
    return [...new Set([user.userId, ...rows.map((r) => Number(r.ID))])];
  }

  private async departmentWithChildren(user: B24UserContext): Promise<number[]> {
    if (!user.departmentIds.length) return [];
    let rows: { ID: string; PARENT?: string | null }[] = [];
    try {
      rows = await user.client.listAll('department.get');
    } catch (err) {
      // Без права department — только прямые отделы сотрудника.
      if (err instanceof Bitrix24Error && ['insufficient_scope', 'ACCESS_DENIED'].includes(err.code))
        return user.departmentIds;
      throw err;
    }
    const children = new Map<number, number[]>();
    for (const r of rows) {
      const parent = Number(r.PARENT);
      if (parent) children.set(parent, [...(children.get(parent) ?? []), Number(r.ID)]);
    }
    const out = new Set<number>();
    const walk = (id: number) => {
      if (out.has(id)) return;
      out.add(id);
      for (const c of children.get(id) ?? []) walk(c);
    };
    user.departmentIds.forEach(walk);
    return [...out];
  }
}

/** Роль пользователя в чате: `guest` — видит, но не участник (нужно «Присоединиться»). */
const isMember = (role: string | undefined) => Boolean(role) && !['guest', 'none'].includes(String(role).toLowerCase());

/** Ключ команды пакета: найденные по ID чата — по чату (сессии может не быть), иначе по сессии. */
const refKey = (s: SessionRef) => (s.chatId ? `c${s.chatId}` : `s${s.sessionId}`);

/** Имя клиента чата: контакт, затем компания, затем лид. */
function clientNameFor(l: ChatSummary['crm'], crm: Map<string, string[]>): string | null {
  const pick = (k: string, id: number | null) => (id ? crm.get(`name:${k}:${id}`)?.[0] : undefined);
  return pick('contact', l.contactId) ?? pick('company', l.companyId) ?? pick('lead', l.leadId) ?? null;
}

/** Без имени из CRM (старый кэш): название чата открытой линии — «Имя - канал - линия». */
export function clientFromTitle(title: string | null): string | null {
  const head = (title ?? '').split(' - ')[0]?.trim();
  return head || null;
}

function phonesFor(l: ChatSummary['crm'], phones: Map<string, string[]>): string[] {
  return [
    ...new Set([
      ...(l.contactId ? (phones.get(`contact:${l.contactId}`) ?? []) : []),
      ...(l.leadId ? (phones.get(`lead:${l.leadId}`) ?? []) : []),
      ...(l.companyId ? (phones.get(`company:${l.companyId}`) ?? []) : []),
    ]),
  ];
}

/**
 * Варианты записи номера для поиска в CRM: «8 (985) 123-45-67», «+7985…», «985…» →
 * +79851234567, 89851234567, 79851234567. Меньше 10 цифр — не номер.
 */
export function phoneVariants(q: string): string[] {
  return clientPhoneVariants(q);
}

type NoReplyMark = { noReplyMessageId: number | null; noReplyByName: string | null; noReplyAt: Date | null };
type FlagMark = { flagAt: Date | null; flagByName: string | null };

/** «!» действует, пока после отметки в чат не написал сотрудник. */
export function flagOf(mark: FlagMark | null | undefined, lastAuthor: string | null | undefined, lastMessageAt: Date | string | null | undefined): { byName: string | null; at: string } | null {
  if (!mark?.flagAt) return null;
  const last = lastMessageAt ? new Date(lastMessageAt).getTime() : 0;
  if (lastAuthor === 'employee' && last > mark.flagAt.getTime()) return null;
  return { byName: mark.flagByName, at: mark.flagAt.toISOString() };
}

/** Отметка «Не требует ответа» действует, пока последнее сообщение — то, на котором её поставили. */
function noReplyOf(mark: NoReplyMark | null, lastMessageId: number | null): ChatSummary['noReply'] {
  if (!mark?.noReplyMessageId && mark?.noReplyMessageId !== 0) return null;
  if (lastMessageId !== null && lastMessageId > mark.noReplyMessageId) return null;
  return { byName: mark.noReplyByName, at: (mark.noReplyAt ?? new Date(0)).toISOString() };
}

/** Ждёт ответа: сессия открыта, последнее сообщение — клиента, и на нём нет отметки «Не требует ответа». */
export function isWaiting(closed: boolean, lastAuthor: string | null, lastMessageId: number | null, mark: NoReplyMark | null): boolean {
  return !closed && lastAuthor === 'client' && noReplyOf(mark, lastMessageId) === null;
}
