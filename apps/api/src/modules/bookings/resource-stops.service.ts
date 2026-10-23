import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { isIsoDate, zonedDayRange, type ResourceStopCheckDto, type ResourceStopDto } from '@btx24/shared';
import { z } from 'zod';
import type { ResourceStop } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AccessService } from '../access/access.service.js';
import { ActionLogService } from '../audit/action-log.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { dealLinks, listBookings } from './bitrix-bookings.js';

const day = z.string().refine(isIsoDate, 'Дата — YYYY-MM-DD');
const periodSchema = z
  .object({ resourceId: z.number().int().positive(), from: day, to: day })
  .strict()
  .refine((b) => b.to >= b.from, { message: 'Конец стопа раньше начала' });
const createSchema = z
  .object({ resourceId: z.number().int().positive(), from: day, to: day, reason: z.string().trim().min(3, 'Укажите причину стопа').max(500) })
  .strict()
  .refine((b) => b.to >= b.from, { message: 'Конец стопа раньше начала' });
/** Дольше — скорее ошибка ввода (и список броней Битрикс24 за такой период тяжёлый). */
const MAX_DAYS = 366;

/**
 * Стоп ресурса (решение владельца 2026-10-23): ресурс закрыт для бронирования на дни периода.
 * Поставить можно, только если броней ресурса в периоде нет (их сначала переносят или отменяют) —
 * проверка по Битрикс24 (источник истины), правами сотрудника. Брони приложения в стоп не создаются
 * (`assertOpen` в создании брони). Право — «Изменение броней» в группе ресурса (или администратор).
 */
@Injectable()
export class ResourceStopsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly log: ActionLogService,
  ) {}

  /** Действующие стопы ресурсов, пересекающие `[start, end)`. */
  async between(portalId: string, start: Date, end: Date, resourceIds: number[] | null, timezone: string): Promise<ResourceStopDto[]> {
    const rows = await this.prisma.resourceStop.findMany({
      where: { portalId, liftedAt: null, startsAt: { lt: end }, endsAt: { gt: start }, ...(resourceIds ? { resourceId: { in: resourceIds } } : {}) },
      orderBy: { startsAt: 'asc' },
    });
    return rows.map((r) => toDto(r, timezone));
  }

  /** Брони и стопы ресурса в периоде — перед установкой стопа. */
  async check(user: B24UserContext, body: unknown): Promise<ResourceStopCheckDto> {
    const p = parse(periodSchema, body);
    await this.allowed(user, p.resourceId);
    return this.conflicts(user, p.resourceId, p.from, p.to);
  }

  async create(user: B24UserContext, body: unknown): Promise<ResourceStopDto> {
    const p = parse(createSchema, body);
    await this.allowed(user, p.resourceId);
    const found = await this.conflicts(user, p.resourceId, p.from, p.to);
    if (found.bookings.length)
      throw new ConflictException({
        code: 'RESOURCE_HAS_BOOKINGS',
        message: `В этот период есть брони (${found.bookings.length}) — перенесите или отмените их, потом ставьте стоп`,
        details: found,
      });
    const tz = user.portal.timezone;
    const row = await this.prisma.resourceStop.create({
      data: {
        portalId: user.portal.id,
        resourceId: p.resourceId,
        startsAt: zonedDayRange(p.from, tz).start,
        endsAt: zonedDayRange(p.to, tz).end,
        reason: p.reason,
        createdByUserId: user.userId,
        createdByName: user.userName.slice(0, 255),
      },
    });
    await this.log.user(user, {
      action: 'resource.stop',
      summary: `Поставил стоп ресурса #${p.resourceId} с ${ru(p.from)} по ${ru(p.to)}: ${p.reason}`,
      entityType: 'resource',
      entityId: p.resourceId,
      details: { from: p.from, to: p.to, reason: p.reason },
      via: 'app',
    });
    return toDto(row, tz);
  }

  async lift(user: B24UserContext, id: string): Promise<void> {
    const row = await this.prisma.resourceStop.findFirst({ where: { id, portalId: user.portal.id, liftedAt: null } });
    if (!row) throw new NotFoundException({ code: 'STOP_NOT_FOUND', message: 'Стоп не найден или уже снят' });
    await this.allowed(user, row.resourceId);
    await this.prisma.resourceStop.update({ where: { id }, data: { liftedAt: new Date(), liftedByName: user.userName.slice(0, 255) } });
    const d = toDto(row, user.portal.timezone);
    await this.log.user(user, {
      action: 'resource.stop_lift',
      summary: `Снял стоп ресурса #${row.resourceId} (${ru(d.from)} — ${ru(d.to)})`,
      entityType: 'resource',
      entityId: row.resourceId,
      via: 'app',
    });
  }

  /** Бронь в стоп не создаётся (стоп — только пока он не снят). */
  async assertOpen(portalId: string, resourceIds: number[], start: Date, end: Date, timezone: string): Promise<void> {
    const stops = await this.between(portalId, start, end, resourceIds, timezone);
    if (stops.length)
      throw new ConflictException({
        code: 'RESOURCE_STOPPED',
        message: `Ресурс закрыт (стоп ${ru(stops[0].from)} — ${ru(stops[0].to)}): ${stops[0].reason}`,
      });
  }

  private async conflicts(user: B24UserContext, resourceId: number, from: string, to: string): Promise<ResourceStopCheckDto> {
    const tz = user.portal.timezone;
    const start = zonedDayRange(from, tz).start;
    const end = zonedDayRange(to, tz).end;
    if ((end.getTime() - start.getTime()) / 86_400_000 > MAX_DAYS + 1)
      throw new BadRequestException({ code: 'STOP_TOO_LONG', message: `Стоп — не длиннее ${MAX_DAYS} дней` });
    const raw = (await listBookings(user.client, Math.floor(start.getTime() / 1000), Math.floor(end.getTime() / 1000))).filter((b) =>
      (b.resourceIds ?? []).map(Number).includes(resourceId),
    );
    const links = raw.length ? await dealLinks(user.client, raw.map((b) => Number(b.id))) : new Map<number, number>();
    const iso = (sec: unknown) => new Date(Number(sec ?? 0) * 1000).toISOString();
    return {
      resourceId,
      from,
      to,
      bookings: raw
        .map((b) => ({ id: Number(b.id), name: b.name ?? '', start: iso(b.datePeriod?.from?.timestamp), end: iso(b.datePeriod?.to?.timestamp), dealId: links.get(Number(b.id)) ?? null }))
        .sort((a, b) => a.start.localeCompare(b.start)),
      stops: await this.between(user.portal.id, start, end, [resourceId], tz),
    };
  }

  private async allowed(user: B24UserContext, resourceId: number): Promise<void> {
    const a = await this.access.resolve(user);
    if (a.isAppAdmin) return;
    if (!a.groups.some((g) => g.permissions.includes('booking.edit') && g.group.resourceIds.includes(resourceId)))
      throw new ForbiddenException({ code: 'NO_STOP_ACCESS', message: 'Ставить стоп могут сотрудники с правом изменять брони в группе ресурса' });
  }
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const p = schema.safeParse(body);
  if (!p.success) throw new BadRequestException({ code: 'INVALID_STOP', message: p.error.issues[0]?.message ?? 'Неверный период стопа' });
  return p.data;
}

const ru = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;

/** День портала, в котором лежит момент (для конца — последний день периода). */
function dayOf(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function toDto(r: ResourceStop, tz: string): ResourceStopDto {
  return {
    id: r.id,
    resourceId: r.resourceId,
    from: dayOf(r.startsAt, tz),
    to: dayOf(new Date(r.endsAt.getTime() - 1), tz),
    start: r.startsAt.toISOString(),
    end: r.endsAt.toISOString(),
    reason: r.reason,
    createdBy: r.createdByName,
    createdAt: r.createdAt.toISOString(),
  };
}
