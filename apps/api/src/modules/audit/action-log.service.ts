import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { isIsoDate, zonedDayRange, classifyActionLog, ACTION_LOG_CATEGORIES, ACTION_LOG_SEVERITIES, type ActionLogDto, type ActionLogEntryDto } from '@btx24/shared';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { CHAIN_ACTION } from '../openlines/chain-send-guard.js';

/** Кто сделал: сотрудник, автоматизация приложения или сам Битрикс24 (как в истории брони). */
export type ActionActor = { kind: 'user'; userId: number; name: string } | { kind: 'system'; name: string } | { kind: 'bitrix'; name: string };

export interface ActionInput {
  action: string;
  summary: string;
  entityType?: string | null;
  entityId?: string | number | null;
  details?: unknown;
  via?: string | null;
}

/** Изменение поля для «было → стало». */
export interface FieldChange {
  field: string;
  label: string;
  before: unknown;
  after: unknown;
}

const PAGE = 100;
const TEXT = 500;

export const userActor = (u: Pick<B24UserContext, 'userId' | 'userName'>): ActionActor => ({ kind: 'user', userId: u.userId, name: u.userName });

/**
 * Журнал действий (⚙ → «Журнал действий», решение владельца 2026-10-22): всё, что делают сотрудники,
 * система и что приложение узнаёт о Битрикс24. Только добавление (триггеры БД). Сбой записи журнала
 * не ломает само действие — только предупреждение в лог сервера.
 */
@Injectable()
export class ActionLogService {
  private readonly logger = new Logger(ActionLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(portalId: string, actor: ActionActor, input: ActionInput): Promise<void> {
    try {
      await this.prisma.actionLog.create({
        data: {
          portalId,
          actorKind: actor.kind,
          userId: actor.kind === 'user' ? actor.userId : null,
          actorName: actor.name.slice(0, 255),
          action: input.action.slice(0, 64),
          entityType: input.entityType ?? null,
          entityId: input.entityId === null || input.entityId === undefined ? null : String(input.entityId).slice(0, 64),
          summary: input.summary.slice(0, TEXT),
          ...(input.details === undefined ? {} : { details: input.details as Prisma.InputJsonValue }),
          via: input.via?.slice(0, 32) ?? null,
        },
      });
    } catch (e) {
      this.logger.warn(`action log write failed (${input.action}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Сотрудник сделал действие через приложение. */
  user(user: B24UserContext, input: ActionInput): Promise<void> {
    return this.log(user.portal.id, userActor(user), input);
  }

  /**
   * Журнал для администраторов: период (дни в поясе портала), сотрудник, объект («сделка 678»),
   * текст; новые сверху, по 100, дальше — курсором `before` (ID записи).
   */
  async list(portalId: string, timezone: string, q: Record<string, unknown>, visibleContacts?: (ids: number[]) => Promise<Set<number>>): Promise<ActionLogDto> {
    const limit = q.limit === undefined ? PAGE : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > PAGE)
      throw new BadRequestException({ code: 'INVALID_LIMIT', message: 'limit: целое число от 1 до 100' });
    const category = q.category === undefined || q.category === '' ? null : q.category;
    const severity = q.severity === undefined || q.severity === '' ? null : q.severity;
    if (category !== null && !ACTION_LOG_CATEGORIES.some((v) => v === category)) throw new BadRequestException('Неизвестная категория журнала');
    if (severity !== null && !ACTION_LOG_SEVERITIES.some((v) => v === severity)) throw new BadRequestException('Неизвестная критичность журнала');
    const day = (v: unknown, name: string) => {
      if (v === undefined || v === '') return null;
      if (typeof v !== 'string' || !isIsoDate(v)) throw new BadRequestException({ code: 'INVALID_PERIOD', message: `${name}: YYYY-MM-DD` });
      return v;
    };
    const from = day(q.from, 'from');
    const to = day(q.to, 'to');
    const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
    const userId = Number(q.userId);
    const entityType = str(q.entityType, 32);
    const entityId = str(q.entityId, 64);
    const text = str(q.q, 100);
    const before = str(q.before, 40);
    const cursor = before ? await this.prisma.actionLog.findFirst({ where: { id: before, portalId }, select: { at: true, id: true } }) : null;
    const where: Prisma.ActionLogWhereInput = {
      portalId,
      // Служебные строки защиты от повтора цепочки: сами сообщения журнал уже показывает.
      action: { not: CHAIN_ACTION },
      ...(from || to
        ? { at: { ...(from ? { gte: zonedDayRange(from, timezone).start } : {}), ...(to ? { lt: zonedDayRange(to, timezone).end } : {}) } }
        : {}),
      ...(Number.isSafeInteger(userId) && userId > 0 ? { userId } : {}),
      ...(q.actorKind === 'system' || q.actorKind === 'bitrix' || q.actorKind === 'user' ? { actorKind: q.actorKind } : {}),
      ...(entityType ? { entityType } : {}),
      ...(entityId ? { entityId } : {}),
      ...(text ? { OR: [{ summary: { contains: text } }, { actorName: { contains: text } }, { action: { contains: text } }] } : {}),
      ...(cursor ? { AND: [{ OR: [{ at: { lt: cursor.at } }, { at: cursor.at, id: { lt: cursor.id } }] }] } : {}),
    };
    // Старые записи неизменяемы. Фильтруем классификацию ДО пагинации, читая индексированные
    // страницы портала/периода, пока не найдём limit+1 совпадений или конец журнала.
    const classified = category !== null || severity !== null || !!visibleContacts;
    const take = classified ? 200 : limit + 1;
    const matches: ActionLogEntryDto[] = [];
    let pageCursor: { id: string; at: Date } | null = null;
    for (;;) {
      const pageWhere: Prisma.ActionLogWhereInput = pageCursor ? { AND: [where, { OR: [{ at: { lt: pageCursor.at } }, { at: pageCursor.at, id: { lt: pageCursor.id } }] }] } : where;
      const rows = await this.prisma.actionLog.findMany({ where: pageWhere, orderBy: [{ at: 'desc' }, { id: 'desc' }], take });
      const contactIds = rows.filter(r => r.entityType === 'contact').map(r => Number(r.entityId)).filter(id => Number.isSafeInteger(id) && id > 0);
      const allowedContacts = contactIds.length && visibleContacts ? await visibleContacts(contactIds) : new Set<number>();
      for (const r of rows) {
        if (r.entityType === 'contact' && !allowedContacts.has(Number(r.entityId))) continue;
        const classification = classifyActionLog(r);
        if (category !== null && classification.category !== category || severity !== null && classification.severity !== severity) continue;
        matches.push({ id: r.id, at: r.at.toISOString(), actorKind: r.actorKind, userId: r.userId,
          actorName: r.actorName, action: r.action, entityType: r.entityType, entityId: r.entityId,
          summary: r.summary, details: r.details ?? null, via: r.via, ...classification });
        if (matches.length > limit) break;
      }
      if (matches.length > limit || rows.length < take) break;
      const last = rows[rows.length - 1];
      pageCursor = { id: last.id, at: last.at };
    }
    const items = matches.slice(0, limit);
    return { items, nextCursor: matches.length > limit ? items[items.length - 1].id : null };
  }
}

/** Изменения между двумя объектами настроек (верхний уровень; вложенное сравнивается целиком). */
export function diffFields(before: Record<string, unknown> | null, after: Record<string, unknown>, labels: Record<string, string> = {}, skip: string[] = []): FieldChange[] {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after)])].filter((k) => !skip.includes(k));
  return keys
    .filter((k) => JSON.stringify(before?.[k] ?? null) !== JSON.stringify(after[k] ?? null))
    .map((k) => ({ field: k, label: labels[k] ?? k, before: before?.[k] ?? null, after: after[k] ?? null }));
}
