import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { BookingRecord, Prisma } from '../../generated/prisma/client.js';

/** Больше — не для экрана менеджера за день-месяц. */
export const LIST_LIMIT = 200;

/** Кто действует: сотрудник (через приложение), автоматизация приложения или сам Битрикс24. */
export type BookingActor =
  | { kind: 'user'; userId: number; name: string }
  | { kind: 'system'; name: string }
  | { kind: 'bitrix'; name: string };

/** Подписи действий системы — как их увидят люди в истории брони. */
export const SYSTEM = {
  paymentTimeout: { kind: 'system', name: 'Система: автоматизация — удаление брони при неоплате' },
  reconcile: { kind: 'system', name: 'Система: сверка с Битрикс24' },
  bitrix: { kind: 'bitrix', name: 'Битрикс24 (вручную в портале или онлайн-запись)' },
} as const satisfies Record<string, BookingActor>;

/** Что сравнивается и показывается в «было/стало». */
export interface BookingState {
  startsAt: string;
  endsAt: string;
  resourceIds: number[];
  dealId: number | null;
}

export interface BookingCreatedInput {
  bookingId: number;
  kind: 'client' | 'service';
  dealId: number | null;
  groupId?: string | null;
  resourceIds: number[];
  startsAt: Date;
  endsAt: Date;
  title?: string | null;
  paymentMode?: 'prepayment' | 'cash_on_site' | 'postpay' | 'free' | 'certificate' | null;
}

export interface BookingCancelInput {
  reason: 'payment_timeout' | 'manual' | 'removed_in_bitrix';
  actor: BookingActor;
  via?: string;
  /** Причина словами (снятие брони сотрудником). */
  comment?: string;
}

export function stateOf(r: Pick<BookingRecord, 'startsAt' | 'endsAt' | 'resourceIds' | 'dealId'>): BookingState {
  return {
    startsAt: r.startsAt.toISOString(),
    endsAt: r.endsAt.toISOString(),
    resourceIds: [...(r.resourceIds as number[])].map(Number).sort((a, b) => a - b),
    dealId: r.dealId,
  };
}

const actorColumns = (a: BookingActor) => ({
  actorKind: a.kind,
  userId: a.kind === 'user' ? a.userId : null,
  actorName: a.name,
});
const json = (v: unknown) => v as Prisma.InputJsonValue;

/**
 * Журнал броней (ADR 0006, 0007): тип, источник, статус, автор, причина отмены и история —
 * кто, что, как и когда. История только добавляется (триггеры БД). Запись и отмена идемпотентны.
 */
@Injectable()
export class BookingJournalService {
  constructor(private readonly prisma: PrismaService) {}

  /** Бронь создана приложением (сотрудник через форму). Повтор возвращает существующую запись. */
  async recordCreated(
    portalId: string,
    input: BookingCreatedInput,
    actor: Extract<BookingActor, { kind: 'user' }>,
  ): Promise<BookingRecord> {
    const existing = await this.find(portalId, input.bookingId);
    // Сверка могла успеть принять бронь как «из Битрикс24» между её созданием и этой записью.
    if (existing?.source === 'bitrix' && existing.createdByUserId === null) {
      const upgraded = await this.prisma.bookingRecord.update({
        where: { id: existing.id },
        data: {
          source: 'app',
          kind: input.kind,
          groupId: input.groupId ?? null,
          createdByUserId: actor.userId,
          paymentMode: input.paymentMode ?? null,
        },
      });
      await this.history(existing.id, 'created', actor, { after: stateOf(upgraded), details: { paymentMode: upgraded.paymentMode, wasImported: true } });
      return upgraded;
    }
    if (existing) return existing;
    const record = await this.prisma.bookingRecord.create({
      data: {
        portalId,
        bookingId: input.bookingId,
        source: 'app',
        title: input.title ?? null,
        kind: input.kind,
        dealId: input.dealId,
        groupId: input.groupId ?? null,
        resourceIds: input.resourceIds,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        createdByUserId: actor.userId,
        paymentMode: input.paymentMode ?? null,
        syncedAt: new Date(),
      },
    });
    await this.history(record.id, 'created', actor, { after: stateOf(record), details: { paymentMode: record.paymentMode } });
    return record;
  }

  /** Бронь найдена в Битрикс24 (создана не приложением). Повтор возвращает существующую запись. */
  async recordImported(portalId: string, input: BookingCreatedInput): Promise<{ record: BookingRecord; created: boolean }> {
    const existing = await this.find(portalId, input.bookingId);
    if (existing) return { record: existing, created: false };
    const record = await this.prisma.bookingRecord.create({
      data: {
        portalId,
        bookingId: input.bookingId,
        source: 'bitrix',
        title: input.title ?? null,
        kind: input.kind,
        dealId: input.dealId,
        resourceIds: input.resourceIds,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        syncedAt: new Date(),
      },
    });
    await this.history(record.id, 'imported', SYSTEM.bitrix, { after: stateOf(record), via: 'reconcile' });
    return { record, created: true };
  }

  /** Принять состояние брони как есть сейчас (изменили в Битрикс24 или сотрудник принял расхождение). */
  async recordChanged(
    record: BookingRecord,
    next: BookingState & { title?: string | null },
    actor: BookingActor,
    action: string,
    via: string,
  ): Promise<BookingRecord> {
    const updated = await this.prisma.bookingRecord.update({
      where: { id: record.id },
      data: {
        startsAt: new Date(next.startsAt),
        endsAt: new Date(next.endsAt),
        resourceIds: next.resourceIds,
        dealId: next.dealId,
        ...(next.title !== undefined ? { title: next.title } : {}),
        syncedAt: new Date(),
      },
    });
    await this.history(record.id, action, actor, { before: stateOf(record), after: stateOf(updated), via });
    return updated;
  }

  /** Отмена: статус `cancelled` + запись в истории. Уже отменённая или неизвестная бронь — null. */
  async recordCancelled(portalId: string, bookingId: number, input: BookingCancelInput): Promise<BookingRecord | null> {
    const at = new Date();
    const { count } = await this.prisma.bookingRecord.updateMany({
      where: { portalId, bookingId, status: 'active' },
      data: {
        status: 'cancelled',
        cancelReason: input.reason,
        cancelledAt: at,
        cancelledByUserId: input.actor.kind === 'user' ? input.actor.userId : null,
      },
    });
    const record = await this.find(portalId, bookingId);
    if (!count || !record) return null;
    await this.history(record.id, 'cancelled', input.actor, {
      before: stateOf(record),
      details: { reason: input.reason, ...(input.comment ? { comment: input.comment } : {}) },
      via: input.via ?? 'app',
      at,
    });
    return record;
  }

  /** Отметка в истории без изменения брони (например, найдено расхождение). */
  async note(recordId: string, action: string, actor: BookingActor, details: unknown, via: string): Promise<void> {
    await this.history(recordId, action, actor, { details, via });
  }

  find(portalId: string, bookingId: number): Promise<BookingRecord | null> {
    return this.prisma.bookingRecord.findUnique({ where: { portalId_bookingId: { portalId, bookingId } } });
  }

  async historyOf(portalId: string, bookingId: number) {
    const record = await this.find(portalId, bookingId);
    if (!record) return null;
    const rows = await this.prisma.bookingHistory.findMany({ where: { recordId: record.id }, orderBy: { at: 'asc' } });
    return { record, rows };
  }

  /** Брони сотрудника: клиентские, созданные в `[from, to)`, и отменённые в `[from, to)` — новые сверху. */
  async forManager(
    portalId: string,
    userId: number,
    from: Date,
    to: Date,
  ): Promise<{ created: number; createdClient: BookingRecord[]; cancelled: BookingRecord[] }> {
    const [created, createdClient, cancelled] = await Promise.all([
      this.prisma.bookingRecord.count({
        where: { portalId, createdByUserId: userId, createdAt: { gte: from, lt: to } },
      }),
      this.prisma.bookingRecord.findMany({
        where: { portalId, createdByUserId: userId, kind: 'client', createdAt: { gte: from, lt: to } },
        orderBy: { createdAt: 'desc' },
        take: LIST_LIMIT,
      }),
      this.prisma.bookingRecord.findMany({
        where: { portalId, createdByUserId: userId, status: 'cancelled', cancelledAt: { gte: from, lt: to } },
        orderBy: { cancelledAt: 'desc' },
        take: LIST_LIMIT,
      }),
    ]);
    return { created, createdClient, cancelled };
  }

  private async history(
    recordId: string,
    action: string,
    actor: BookingActor,
    o: { before?: unknown; after?: unknown; details?: unknown; via?: string; at?: Date },
  ): Promise<void> {
    await this.prisma.bookingHistory.create({
      data: {
        recordId,
        action,
        ...actorColumns(actor),
        via: o.via ?? 'app',
        ...(o.before !== undefined ? { before: json(o.before) } : {}),
        ...(o.after !== undefined ? { after: json(o.after) } : {}),
        ...(o.details !== undefined ? { details: json(o.details) } : {}),
        ...(o.at ? { at: o.at } : {}),
      },
    });
  }
}
