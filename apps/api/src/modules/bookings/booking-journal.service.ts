import { Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { BookingRecord, Prisma } from '../../generated/prisma/client.js';
import { ActionLogService } from '../audit/action-log.service.js';

/** Броней за период на дашборде: больше — не для экрана менеджера за день-месяц (список обрезается). */
export const PERIOD_LIMIT = 1000;

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

export interface BookingVersion {
  id: string;
  at: string;
  action: string;
  actorName: string | null;
  state: BookingState;
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
  /** Когда бронь появилась (импорт): Битрикс24 дату создания не отдаёт; по умолчанию — сейчас. */
  createdAt?: Date;
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
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly actions?: ActionLogService,
  ) {}

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
      await this.history(upgraded, 'created', actor, { after: stateOf(upgraded), details: { paymentMode: upgraded.paymentMode, wasImported: true } });
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
    await this.history(record, 'created', actor, { after: stateOf(record), details: { paymentMode: record.paymentMode } });
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
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      },
    });
    await this.history(record, 'imported', SYSTEM.bitrix, { after: stateOf(record), via: 'reconcile' });
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
    await this.history(updated, action, actor, { before: stateOf(record), after: stateOf(updated), via });
    return updated;
  }

  /**
   * Бронь, пропавшую в Битрикс24, создали там заново по данным приложения: у неё новый ID. Запись
   * журнала (тип, автор, история) та же — меняется только ID брони; прежний — в истории.
   */
  async recordRecreated(record: BookingRecord, bookingId: number, actor: BookingActor): Promise<BookingRecord> {
    const updated = await this.prisma.bookingRecord.update({ where: { id: record.id }, data: { bookingId, syncedAt: new Date() } });
    await this.history(updated, 'recreated_in_bitrix', actor, { after: stateOf(updated), details: { previousBookingId: record.bookingId }, via: 'app' });
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
    await this.history(record, 'cancelled', input.actor, {
      before: stateOf(record),
      details: { reason: input.reason, ...(input.comment ? { comment: input.comment } : {}) },
      via: input.via ?? 'app',
      at,
    });
    return record;
  }

  /** Отметка в истории без изменения брони (например, найдено расхождение). */
  async note(record: BookingRecord, action: string, actor: BookingActor, details: unknown, via: string): Promise<void> {
    await this.history(record, action, actor, { details, via });
  }

  /** Снятая у нас бронь жива в Битрикс24, сотрудник принял её: снова активна, данные — как в Битрикс24. */
  async recordReactivated(record: BookingRecord, next: BookingState, actor: BookingActor): Promise<BookingRecord> {
    const updated = await this.prisma.bookingRecord.update({
      where: { id: record.id },
      data: {
        status: 'active',
        cancelReason: null,
        cancelledAt: null,
        cancelledByUserId: null,
        startsAt: new Date(next.startsAt),
        endsAt: new Date(next.endsAt),
        resourceIds: next.resourceIds,
        dealId: next.dealId,
        syncedAt: new Date(),
      },
    });
    await this.history(updated, 'accepted_bitrix', actor, { before: stateOf(record), after: stateOf(updated), details: { reactivated: true }, via: 'app' });
    return updated;
  }

  /**
   * Запись по ID брони, в том числе прежнему: после «создать заново» у брони новый ID, а старые
   * уведомления ссылаются на прежний (он — в истории `recreated_in_bitrix`).
   */
  async findAny(portalId: string, bookingId: number): Promise<BookingRecord | null> {
    const direct = await this.find(portalId, bookingId);
    if (direct) return direct;
    const row = await this.prisma.bookingHistory.findFirst({
      where: { action: 'recreated_in_bitrix', record: { portalId }, details: { path: '$.previousBookingId', equals: bookingId } },
      orderBy: { at: 'desc' },
      include: { record: true },
    });
    return row?.record ?? null;
  }

  /**
   * Версии данных брони — снимки «после» из истории (создана, найдена, изменена, принята, откат,
   * создана заново), новые сверху; подряд одинаковые — одна версия.
   */
  async versions(record: BookingRecord, offset: number, limit: number): Promise<{ items: (BookingVersion & { current: boolean })[]; hasMore: boolean }> {
    const rows = await this.prisma.bookingHistory.findMany({ where: { recordId: record.id }, orderBy: { at: 'desc' } });
    const key = (st: BookingState) => `${st.startsAt}|${st.endsAt}|${[...st.resourceIds].sort((a, b) => a - b).join('.')}|${st.dealId ?? ''}`;
    const all: BookingVersion[] = [];
    for (const r of rows) {
      const st = r.after as BookingState | null;
      if (!st?.startsAt) continue;
      const v = { id: r.id, at: r.at.toISOString(), action: r.action, actorName: r.actorName, state: { ...st, resourceIds: st.resourceIds.map(Number) } };
      if (all.length && key(all[all.length - 1].state) === key(v.state)) continue;
      all.push(v);
    }
    const now = key(stateOf(record));
    return { items: all.slice(offset, offset + limit).map((v) => ({ ...v, current: key(v.state) === now })), hasMore: all.length > offset + limit };
  }

  /** Версия по записи истории (для отката); чужая запись — null. */
  async version(record: BookingRecord, historyId: string): Promise<BookingState | null> {
    const row = await this.prisma.bookingHistory.findFirst({ where: { id: historyId, recordId: record.id } });
    const st = row?.after as BookingState | null | undefined;
    return st?.startsAt ? { ...st, resourceIds: st.resourceIds.map(Number) } : null;
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
  /** Активные брони, пересекающие `[from, to)`, на ресурсах `resourceIds` (null — все). */
  async activeBetween(portalId: string, from: Date, to: Date, resourceIds: number[] | null): Promise<number> {
    const rows = await this.prisma.bookingRecord.findMany({
      where: { portalId, status: 'active', startsAt: { lt: to }, endsAt: { gt: from } },
      select: { resourceIds: true },
      take: PERIOD_LIMIT,
    });
    return rows.filter((r) => resourceIds === null || (r.resourceIds as number[]).some((id) => resourceIds.includes(Number(id)))).length;
  }

  /** Активные брони, пересекающие [from, to) — по ресурсам (null — все), по началу. */
  async activeListBetween(portalId: string, from: Date, to: Date, resourceIds: number[] | null): Promise<BookingRecord[]> {
    const rows = await this.prisma.bookingRecord.findMany({
      where: { portalId, status: 'active', startsAt: { lt: to }, endsAt: { gt: from } },
      orderBy: { startsAt: 'asc' },
      take: PERIOD_LIMIT,
    });
    return rows.filter((r) => resourceIds === null || (r.resourceIds as number[]).some((id) => resourceIds.includes(Number(id))));
  }

  /**
   * Брони из списка, пропавшие в Битрикс24 и ждущие решения: по ним есть уведомление «брони нет» —
   * в любом статусе (его могли отметить «Решено» вручную). Решение само снимает признак: «удалить в
   * приложении» отменяет запись, «создать заново» меняет её ID. Вызывать для активных записей.
   */
  async pendingRemoval(portalId: string, bookingIds: number[]): Promise<Set<number>> {
    if (!bookingIds.length) return new Set();
    const rows = await this.prisma.bookingAlert.findMany({
      where: { portalId, bookingId: { in: bookingIds }, kind: 'discrepancy', problem: { contains: 'missing' } },
      select: { bookingId: true },
    });
    return new Set(rows.map((r) => r.bookingId));
  }

  /** Бронь по сделкам: есть активная — booked, и оплачен счёт приложения по сделке — paid. */
  async dealBookingState(portalId: string, dealIds: number[]): Promise<Map<number, 'booked' | 'paid'>> {
    const out = new Map<number, 'booked' | 'paid'>();
    if (!dealIds.length) return out;
    const [booked, paid] = await Promise.all([
      this.prisma.bookingRecord.findMany({ where: { portalId, status: 'active', dealId: { in: dealIds } }, select: { dealId: true, bookingId: true } }),
      this.prisma.paymentRequest.findMany({ where: { portalId, status: 'paid', dealId: { in: dealIds } }, select: { dealId: true } }),
    ]);
    // Пропавшая в Битрикс24 бронь — уже не бронь сделки (ждёт решения в календаре).
    const gone = await this.pendingRemoval(portalId, booked.map((b) => b.bookingId));
    const paidIds = new Set(paid.map((p) => p.dealId));
    for (const b of booked) if (b.dealId && !gone.has(b.bookingId)) out.set(b.dealId, paidIds.has(b.dealId) ? 'paid' : 'booked');
    return out;
  }

  /**
   * Брони за период для дашборда — любого источника (приложение и найденные в Битрикс24): новые
   * (появились в журнале за период) и удалённые (отменены за период), плюс брони приложения, пропавшие
   * в Битрикс24 и ждущие решения. `resourceIds` — ресурсы групп пользователя (null — все); `userId` —
   * «Мои»: создал или снял этот сотрудник.
   */
  async forPeriod(
    portalId: string,
    from: Date,
    to: Date,
    o: { resourceIds: number[] | null; userId: number | null },
  ): Promise<{ created: BookingRecord[]; removed: BookingRecord[]; pending: Set<number> }> {
    const mine = o.userId === null ? {} : { createdByUserId: o.userId };
    const [created, cancelled, missing] = await Promise.all([
      this.prisma.bookingRecord.findMany({ where: { portalId, ...mine, createdAt: { gte: from, lt: to } }, orderBy: { createdAt: 'desc' }, take: PERIOD_LIMIT }),
      this.prisma.bookingRecord.findMany({
        where: { portalId, status: 'cancelled', cancelledAt: { gte: from, lt: to }, ...(o.userId === null ? {} : { OR: [{ createdByUserId: o.userId }, { cancelledByUserId: o.userId }] }) },
        orderBy: { cancelledAt: 'desc' },
        take: PERIOD_LIMIT,
      }),
      this.prisma.bookingAlert.findMany({
        where: { portalId, kind: 'discrepancy', problem: { contains: 'missing' }, createdAt: { gte: from, lt: to } },
        select: { bookingId: true },
      }),
    ]);
    const gone = missing.length
      ? await this.prisma.bookingRecord.findMany({ where: { portalId, ...mine, status: 'active', bookingId: { in: missing.map((m) => m.bookingId) } } })
      : [];
    const inScope = (r: BookingRecord) => o.resourceIds === null || (r.resourceIds as number[]).some((id) => o.resourceIds!.includes(Number(id)));
    return {
      created: created.filter(inScope),
      removed: [...gone, ...cancelled].filter(inScope),
      pending: new Set(gone.map((r) => r.bookingId)),
    };
  }

  /** История брони + та же запись в общем журнале действий (⚙ → «Журнал действий»). */
  private async history(
    record: BookingRecord,
    action: string,
    actor: BookingActor,
    o: { before?: unknown; after?: unknown; details?: unknown; via?: string; at?: Date },
  ): Promise<void> {
    await this.actions?.log(record.portalId, actor, {
      action: `booking.${action}`,
      summary: bookingSummary(record, action, actor, o.details),
      entityType: 'booking',
      entityId: record.bookingId,
      details: { title: record.title, dealId: record.dealId, before: o.before ?? null, after: o.after ?? null, details: o.details ?? null },
      via: o.via ?? 'app',
    });
    await this.prisma.bookingHistory.create({
      data: {
        recordId: record.id,
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

const CANCEL_TEXT: Record<string, string> = {
  payment_timeout: 'не оплачена в срок — снята автоматически',
  manual: 'снята сотрудником',
  removed_in_bitrix: 'удалена в Битрикс24',
};
const ACTION_TEXT: Record<string, string> = {
  imported: 'найдена в Битрикс24 (создана там)',
  changed_in_bitrix: 'изменена в Битрикс24',
  discrepancy_found: 'не совпадает с Битрикс24 — уведомление',
  deleted_in_bitrix: 'удалена в Битрикс24 по решению сотрудника',
  recreated_in_bitrix: 'создана в Битрикс24 заново по данным приложения',
  rolled_back: 'откат: в Битрикс24 возвращена прежняя версия',
  accepted_bitrix: 'принята как в Битрикс24',
  paid: 'оплата получена',
  payment_cancelled: 'счёт переведён в «Не оплачен» в Битрикс24',
};

/** Строка журнала действий о брони: «Создал бронь #555 «Иванов»», «Бронь #555 снята: не оплачена…». */
export function bookingSummary(r: Pick<BookingRecord, 'bookingId' | 'title' | 'dealId'>, action: string, actor: BookingActor, details: unknown): string {
  const name = `бронь #${r.bookingId}${r.title ? ` «${r.title}»` : ''}${r.dealId ? ` (сделка #${r.dealId})` : ''}`;
  const d = (details ?? {}) as { reason?: string; comment?: string };
  if (action === 'created') return actor.kind === 'user' ? `Создал ${name}` : `Создана ${name}`;
  if (action === 'cancelled') {
    const why = CANCEL_TEXT[d.reason ?? ''] ?? 'снята';
    return `${actor.kind === 'user' ? `Снял ${name}` : `${name[0].toUpperCase()}${name.slice(1)}: ${why}`}${d.comment ? ` — «${d.comment}»` : ''}`;
  }
  return `${name[0].toUpperCase()}${name.slice(1)}: ${ACTION_TEXT[action] ?? action}`;
}
