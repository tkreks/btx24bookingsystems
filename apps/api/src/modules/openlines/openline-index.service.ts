import { Injectable, Logger } from '@nestjs/common';
import type { OpenlineChat, Portal } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Bitrix24RestClient } from '../bitrix24/rest/rest-client.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { clientAvatarOf, connectorOf, crmLinksOf, lastMeaningful, messageText, preview, type ImMessage, type ImUser } from './chat-parsing.js';

/** Индекс считается живым, если обновлялся не позже этого (иначе — запасной способ без индекса). */
const FRESH_MS = 15 * 60_000;
/** Первый проход берёт закрытые сессии за неделю, дальше — изменённые с прошлого прохода. */
const FIRST_RUN_MS = 7 * 24 * 3600_000;
const OVERLAP_MS = 10 * 60_000;
/** Сообщений чата на проход: среди них ищем последнее сообщение клиента или оператора. */
const MESSAGES_PER_CHAT = 20;
const BATCH = 50;

export interface IndexedSession {
  chatId: number;
  sessionId: number;
  responsibleId: number | null;
  completed: boolean;
  lastMessageAt: Date | null;
}

interface Activity {
  ASSOCIATED_ENTITY_ID: string;
  RESPONSIBLE_ID: string;
  COMPLETED: 'Y' | 'N';
}

/**
 * Индекс диалогов для сортировки «по дате последнего сообщения», как в списке диалогов
 * Битрикс24. Дата — последнее сообщение клиента или оператора (системные и боты не в счёт).
 * Ведётся только при включённом «сборе метаданных диалогов»; тексты и имена не сохраняются.
 * Обходит открытые сессии целиком: дата изменения дела CRM не следует за сообщениями.
 */
@Injectable()
export class OpenlineIndexService {
  private readonly logger = new Logger(OpenlineIndexService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Включён сбор метаданных и индекс свежий — список можно строить по нему. */
  async isActive(portalId: string, now = new Date()): Promise<boolean> {
    const settings = await this.prisma.portalSettings.findUnique({
      where: { portalId },
      select: { dialogMetadataEnabled: true },
    });
    if (!settings?.dialogMetadataEnabled) return false;
    const fresh = await this.prisma.openlineChat.findFirst({
      where: { portalId, checkedAt: { gte: new Date(now.getTime() - FRESH_MS) } },
      select: { id: true },
    });
    return Boolean(fresh);
  }

  /** Строки индекса по ID чатов (для найденных не через индекс чатов). */
  async byChat(portalId: string, chatIds: number[]) {
    if (!chatIds.length) return new Map<number, OpenlineChat>();
    const rows = await this.prisma.openlineChat.findMany({ where: { portalId, chatId: { in: chatIds } } });
    return new Map(rows.map((r) => [r.chatId, r]));
  }

  /** Страница индекса: сначала свежие сообщения; `responsible` — фильтр по ответственному. */
  async page(portalId: string, responsible: number[] | null, offset: number, take: number): Promise<IndexedSession[]> {
    const rows = await this.prisma.openlineChat.findMany({
      where: { portalId, lastMessageAt: { not: null }, ...(responsible ? { responsibleId: { in: responsible } } : {}) },
      orderBy: [{ lastMessageAt: 'desc' }, { chatId: 'desc' }],
      skip: offset,
      take,
      select: { chatId: true, sessionId: true, responsibleId: true, completed: true, lastMessageAt: true },
    });
    return rows;
  }

  /** Сбор текстов выключен — тексты превью в кэше списка чатов удаляем. */
  async purgeTexts(portalId: string): Promise<number> {
    const { count } = await this.prisma.openlineChat.updateMany({ where: { portalId, lastPreview: { not: null } }, data: { lastPreview: null } });
    return count;
  }

  /** Сбор выключен — собранные метаданные удаляем. */
  async purge(portalId: string): Promise<number> {
    const { count } = await this.prisma.openlineChat.deleteMany({ where: { portalId } });
    await this.prisma.openlineChatAccess.deleteMany({ where: { portalId } });
    return count;
  }

  /** Один проход по порталу (клиентом приложения). Возвращает число обновлённых чатов. */
  async refresh(portal: Portal, client: Bitrix24RestClient, now = new Date()): Promise<number> {
    const last = await this.prisma.openlineChat.aggregate({
      where: { portalId: portal.id },
      _max: { checkedAt: true },
    });
    const since = last._max.checkedAt
      ? new Date(last._max.checkedAt.getTime() - OVERLAP_MS)
      : new Date(now.getTime() - FIRST_RUN_MS);
    const select = ['ID', 'ASSOCIATED_ENTITY_ID', 'RESPONSIBLE_ID', 'COMPLETED'];
    const [open, closed] = await Promise.all([
      client.listAll<Activity>(
        'crm.activity.list',
        { filter: { PROVIDER_ID: 'IMOPENLINES_SESSION', COMPLETED: 'N' }, select },
        { max: 5000 },
      ),
      client.listAll<Activity>(
        'crm.activity.list',
        {
          filter: { PROVIDER_ID: 'IMOPENLINES_SESSION', COMPLETED: 'Y', '>=LAST_UPDATED': since.toISOString() },
          select,
        },
        { max: 5000 },
      ),
    ]);
    const sessions = new Map<number, Activity>();
    for (const a of [...closed, ...open])
      if (Number(a.ASSOCIATED_ENTITY_ID) > 0) sessions.set(Number(a.ASSOCIATED_ENTITY_ID), a);

    // Сессия → чат; у чата берём последнюю (наибольшую) сессию.
    const chats = new Map<number, { session: number; activity: Activity; connector: string; title: string | null; entityData2: string | null }>();
    const list = [...sessions.entries()];
    for (let i = 0; i < list.length; i += BATCH) {
      const part = list.slice(i, i + BATCH);
      const res = await client.batch(
        Object.fromEntries(
          part.map(([sid]) => [`s${sid}`, { method: 'imopenlines.dialog.get', params: { SESSION_ID: sid } }]),
        ),
      );
      for (const [sid, a] of part) {
        const d = res.result[`s${sid}`] as { id?: number; entity_id?: string; name?: string; entity_data_2?: string } | undefined;
        if (!d?.id) continue;
        const prev = chats.get(d.id);
        if (!prev || prev.session < sid)
          chats.set(d.id, { session: sid, activity: a, connector: connectorOf(d.entity_id), title: d.name ?? null, entityData2: d.entity_data_2 ?? null });
      }
    }

    const ids = [...chats.keys()];
    let updated = 0;
    // Сводка для кэша списка чатов; текст превью — только при включённом «сборе текстов».
    const texts = (await this.prisma.portalSettings.findUnique({ where: { portalId: portal.id }, select: { dialogTextsEnabled: true } }))?.dialogTextsEnabled === true;
    for (let i = 0; i < ids.length; i += BATCH) {
      const part = ids.slice(i, i + BATCH);
      const res = await client.batch(
        Object.fromEntries(
          part.map((id) => [
            `c${id}`,
            { method: 'im.dialog.messages.get', params: { DIALOG_ID: `chat${id}`, LIMIT: MESSAGES_PER_CHAT } },
          ]),
        ),
      );
      for (const chatId of part) {
        const m = (res.result[`c${chatId}`] ?? {}) as { messages?: ImMessage[]; users?: ImUser[] };
        const last = lastMeaningful(m.messages ?? [], m.users ?? []);
        const c = chats.get(chatId)!;
        const meta = {
          sessionId: c.session,
          responsibleId: Number(c.activity.RESPONSIBLE_ID) || null,
          completed: c.activity.COMPLETED === 'Y',
          connector: c.connector.slice(0, 64),
          checkedAt: now,
          // Среди последних сообщений нет человеческих — прежнюю дату не затираем.
          ...(last?.human ? { lastMessageAt: new Date(last.message.date), lastAuthor: last.kind } : {}),
          ...(c.title !== null ? { title: c.title.slice(0, 255) } : {}),
          crm: crmLinksOf(c.entityData2) as unknown as Prisma.InputJsonValue,
          ...(m.users?.length ? { clientAvatar: clientAvatarOf(m.users, portal.domain) } : {}),
          ...(last
            ? {
                lastMessageId: Number(last.message.id),
                lastPreview: texts ? preview(messageText(last.message.text)).slice(0, 500) : null,
                lastHasFiles: Boolean(last.message.params?.FILE_ID?.length),
              }
            : {}),
          summaryAt: now,
        };
        await this.prisma.openlineChat.upsert({
          where: { portalId_chatId: { portalId: portal.id, chatId } },
          create: { portalId: portal.id, chatId, ...meta },
          update: meta,
        });
        updated++;
      }
    }
    // Были открыты, но в этот проход не встретились — значит, закрыты давно.
    await this.prisma.openlineChat.updateMany({
      where: { portalId: portal.id, completed: false, checkedAt: { lt: now } },
      data: { completed: true },
    });
    this.logger.log(`portal ${portal.id}: ${sessions.size} sessions, ${updated} chats indexed`);
    return updated;
  }
}
