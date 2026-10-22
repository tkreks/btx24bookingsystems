import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  ChatHistoryDto,
  ChatListDto,
  ChatScope,
  ChatSummary,
  SendResultDto,
  TemplateStepDto,
} from '@btx24/shared';
import { z } from 'zod';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { bitrix24ErrorMessage } from '../bitrix24/http/bitrix24-error.filter.js';
import { Bitrix24Error } from '../bitrix24/rest/errors.js';
import {
  connectorOf,
  crmLinksOf,
  lastMeaningful,
  preview,
  toMessageDto,
  type ImFile,
  type ImMessage,
  type ImUser,
} from './chat-parsing.js';
import { PrismaService } from '../../prisma/prisma.service.js';
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
/** Сообщений на чат в сводке: среди них ищем последнее от клиента или оператора. */
const SUMMARY_MESSAGES = 20;
const listQuery = z
  .object({
    scope: z.enum(['mine', 'department', 'all']).default('mine'),
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
  constructor(
    private readonly files: FilesService,
    private readonly index: OpenlineIndexService,
    private readonly prisma?: PrismaService,
  ) {}

  /** Мои папки: чат → папка. */
  async myFolders(user: B24UserContext): Promise<Map<number, string>> {
    if (!this.prisma) return new Map();
    const items = await this.prisma.chatFolderItem.findMany({ where: { portalId: user.portal.id, ownerUserId: user.userId } });
    return new Map(items.map((i) => [i.chatId, i.folderId]));
  }

  /** Непрочитанные по чатам открытых линий — личные счётчики мессенджера сотрудника. */
  async unreadByChat(user: B24UserContext): Promise<Map<number, number>> {
    try {
      const res = await user.client.call<{ items?: { id?: string | number; chat_id?: number | string; counter?: number }[] }>(
        'im.recent.list',
        { ONLY_OPENLINES: 'Y', LIMIT: 200 },
      );
      const out = new Map<number, number>();
      for (const i of res.result?.items ?? []) {
        const chatId = Number(i.chat_id) || Number(String(i.id ?? '').replace(/^chat/, ''));
        if (chatId > 0 && Number(i.counter) > 0) out.set(chatId, Number(i.counter));
      }
      return out;
    } catch (err) {
      if (err instanceof Bitrix24Error) return new Map();
      throw err;
    }
  }

  /** Сводки чатов по их ID (папка, поиск): порядок — по последнему сообщению. */
  async summariesByChat(user: B24UserContext, chatIds: number[]): Promise<ChatSummary[]> {
    const indexed = await this.index.byChat(user.portal.id, chatIds);
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
    const { scope, offset, folder } = parsed.data;
    const folders = await this.myFolders(user);
    if (folder) {
      const chatIds = [...folders].filter(([, f]) => f === folder).map(([c]) => c);
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
      const items = await this.summaries(
        user,
        rows.map((r) => ({
          sessionId: r.sessionId,
          responsibleId: r.responsibleId,
          completed: r.completed,
          indexedAt: r.lastMessageAt,
        })),
      );
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
    const [phones, unread, folders] = await Promise.all([
      this.phonesOf(user, unique.map(({ d }) => crmLinksOf(d.entity_data_2))),
      this.unreadByChat(user),
      this.myFolders(user),
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
        chatId: Number(d.id),
        sessionId: s.sessionId,
        title: d.name ?? `Чат #${d.id}`,
        connector: connectorOf(d.entity_id),
        responsibleId: s.responsibleId,
        lastMessage: last
          ? {
              id: Number(last.message.id),
              date: last.message.date,
              author: last.kind,
              preview: preview(last.message.text),
              hasFiles: Boolean(last.message.params?.FILE_ID?.length),
            }
          : null,
        waitingReply: !sessionClosed && last?.human === true && last.kind === 'client',
        joined: isMember(d.role),
        sessionClosed,
        crm: crmLinksOf(d.entity_data_2),
        phones: phonesFor(crmLinksOf(d.entity_data_2), phones),
        unread: unread.get(Number(d.id)) ?? 0,
        folderId: folders.get(Number(d.id)) ?? null,
      };
      return { summary, sortKey };
    });
    return summaries.sort((a, b) => b.sortKey - a.sortKey).map((x) => x.summary);
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

  /** Телефоны привязанных контактов, лидов и компаний — одним пакетом, правами пользователя. */
  private async phonesOf(user: B24UserContext, links: ChatSummary['crm'][]): Promise<Map<string, string[]>> {
    const ids = {
      contact: [...new Set(links.map((l) => l.contactId).filter((x): x is number => !!x))],
      lead: [...new Set(links.map((l) => l.leadId).filter((x): x is number => !!x))],
      company: [...new Set(links.map((l) => l.companyId).filter((x): x is number => !!x))],
    };
    const commands = Object.fromEntries(
      (Object.keys(ids) as (keyof typeof ids)[])
        .filter((k) => ids[k].length)
        .map((k) => [k, { method: `crm.${k}.list`, params: { filter: { '@ID': ids[k] }, select: ['ID', 'PHONE'] } }]),
    );
    const out = new Map<string, string[]>();
    if (!Object.keys(commands).length) return out;
    try {
      const res = await user.client.batch(commands);
      for (const k of Object.keys(commands)) {
        for (const row of (res.result[k] as { ID: string; PHONE?: { VALUE?: string }[] }[] | undefined) ?? [])
          out.set(`${k}:${row.ID}`, (row.PHONE ?? []).map((p) => String(p.VALUE ?? '')).filter(Boolean));
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
    const dialog = (await user.client.call<ImDialog>('imopenlines.dialog.get', { CHAT_ID: chatId })).result;
    const res = await user.client.call<ImMessages>('im.dialog.messages.get', {
      DIALOG_ID: `chat${chatId}`,
      LIMIT: HISTORY_LIMIT,
      ...(parsed.data.beforeId ? { LAST_ID: parsed.data.beforeId } : {}),
    });
    const users = res.result?.users ?? [];
    const files = res.result?.files ?? [];
    const raw = res.result?.messages ?? [];
    const joined = isMember(dialog.role);
    return {
      chatId,
      title: dialog.name ?? `Чат #${chatId}`,
      connector: connectorOf(dialog.entity_id),
      joined,
      canSend: joined && canSendRight,
      crm: crmLinksOf(dialog.entity_data_2),
      messages: raw.map((m) => toMessageDto(m, users, files)).sort((a, b) => a.id - b.id),
      hasMore: raw.length >= HISTORY_LIMIT,
    };
  }

  /** Войти в диалог оператором (`imopenlines.session.join`). В режиме «только чтение» запрещено. */
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
  const digits = q.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return [];
  if (digits.length === 10) return [`+7${digits}`, `8${digits}`, `7${digits}`];
  if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) {
    const rest = digits.slice(1);
    return [`+7${rest}`, `8${rest}`, `7${rest}`];
  }
  return [`+${digits}`, digits];
}
