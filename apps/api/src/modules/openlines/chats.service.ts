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

/** Сессия для сводки: из дела CRM или из индекса. */
interface SessionRef {
  sessionId: number;
  responsibleId: number | null;
  completed: boolean;
  /** Дата из индекса — ключ сортировки (живая дата важнее, если новее). */
  indexedAt?: Date | null;
}

const HISTORY_LIMIT = 50;
const PAGE = 50;
/** Сообщений на чат в сводке: среди них ищем последнее от клиента или оператора. */
const SUMMARY_MESSAGES = 20;
const listQuery = z
  .object({
    scope: z.enum(['mine', 'department', 'all']).default('mine'),
    offset: z.coerce.number().int().min(0).default(0),
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
  ) {}

  async list(user: B24UserContext, query: unknown): Promise<ChatListDto> {
    const parsed = listQuery.safeParse(query);
    if (!parsed.success)
      throw new BadRequestException({ code: 'INVALID_QUERY', message: 'Неверные параметры списка чатов' });
    const { scope, offset } = parsed.data;
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
      return { items, nextOffset: rows.length === PAGE ? offset + PAGE : null, exactOrder: true };
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
    return { items, nextOffset: res.next ?? null, exactOrder: false };
  }

  /** Сводки чатов для сессий: два пакетных запроса (диалоги, затем последние сообщения). */
  async summaries(user: B24UserContext, sessions: SessionRef[]): Promise<ChatSummary[]> {
    if (!sessions.length) return [];
    const dialogs = await user.client.batch(
      Object.fromEntries(
        sessions.map((s) => [
          `s${s.sessionId}`,
          { method: 'imopenlines.dialog.get', params: { SESSION_ID: s.sessionId } },
        ]),
      ),
    );
    // Нет доступа к диалогу (ACCESS_ERROR) — такой чат пользователю не показываем.
    const pairs = sessions
      .map((s) => ({ s, d: dialogs.result[`s${s.sessionId}`] as ImDialog | undefined }))
      .filter((x): x is { s: SessionRef; d: ImDialog } => Boolean(x.d?.id));
    const unique = [...new Map(pairs.map((x) => [x.d.id, x])).values()];
    if (!unique.length) return [];
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
      };
      return { summary, sortKey };
    });
    return summaries.sort((a, b) => b.sortKey - a.sortKey).map((x) => x.summary);
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

  /**
   * Цепочка сообщений по порядку. Шаг с вложениями — `im.v2.File.upload` (текст уходит с
   * первым файлом), без вложений — `im.message.add`. На ошибке останавливаемся и сообщаем,
   * сколько шагов ушло: повтор отправит только оставшиеся (интерфейс убирает отправленные).
   */
  async send(user: B24UserContext, chatId: number, body: unknown): Promise<SendResultDto> {
    const parsed = sendBody.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException({ code: 'INVALID_CHAIN', message: 'Цепочка пуста или шаг без текста и вложений' });
    const steps: TemplateStepDto[] = parsed.data.steps;
    const files = await this.files.loadOwned(user, [...new Set(steps.flatMap((s) => s.fileIds))]);
    const dialogId = `chat${chatId}`;
    const messageIds: number[] = [];
    for (const [i, step] of steps.entries()) {
      try {
        if (!step.fileIds.length) {
          const res = await user.client.call<number>('im.message.add', { DIALOG_ID: dialogId, MESSAGE: step.text });
          messageIds.push(Number(res.result));
          continue;
        }
        for (const [j, id] of step.fileIds.entries()) {
          const f = files.get(id)!;
          const res = await user.client.call<{ messageId?: number }>('im.v2.File.upload', {
            dialogId,
            fields: {
              FILE: {
                name: f.name,
                content: f.data.toString('base64'),
                ...(j === 0 && step.text ? { message: step.text } : {}),
              },
            },
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
