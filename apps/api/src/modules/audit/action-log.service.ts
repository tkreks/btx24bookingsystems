import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { isIsoDate, zonedDayRange, type ActionLogDto, type ActionLogEntryDto } from '@btx24/shared';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';

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
  async list(portalId: string, timezone: string, q: Record<string, unknown>): Promise<ActionLogDto> {
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
    const rows = await this.prisma.actionLog.findMany({ where, orderBy: [{ at: 'desc' }, { id: 'desc' }], take: PAGE + 1 });
    const items: ActionLogEntryDto[] = rows.slice(0, PAGE).map((r) => ({
      id: r.id,
      at: r.at.toISOString(),
      actorKind: r.actorKind,
      userId: r.userId,
      actorName: r.actorName,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      summary: r.summary,
      details: r.details ?? null,
      via: r.via,
    }));
    return { items, nextCursor: rows.length > PAGE ? items[items.length - 1].id : null };
  }
}

/** Изменения между двумя объектами настроек (верхний уровень; вложенное сравнивается целиком). */
export function diffFields(before: Record<string, unknown> | null, after: Record<string, unknown>, labels: Record<string, string> = {}, skip: string[] = []): FieldChange[] {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after)])].filter((k) => !skip.includes(k));
  return keys
    .filter((k) => JSON.stringify(before?.[k] ?? null) !== JSON.stringify(after[k] ?? null))
    .map((k) => ({ field: k, label: labels[k] ?? k, before: before?.[k] ?? null, after: after[k] ?? null }));
}
