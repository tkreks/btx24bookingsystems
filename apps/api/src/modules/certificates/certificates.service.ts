import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  CERTIFICATE_NUMBER,
  CERTIFICATE_STATUS_LABELS,
  CERTIFICATE_STATUSES,
  isIsoDate,
  todayIn,
  type CertificateAction,
  type CertificateDetailsDto,
  type CertificateDto,
  type CertificateEventDto,
  type CertificateListDto,
  type CertificateStatus,
} from '@btx24/shared';
import { z } from 'zod';
import { Prisma, type Certificate, type CertificateEvent } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AccessService } from '../access/access.service.js';
import { ActionLogService } from '../audit/action-log.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';

/** В списке — не больше (поиск сужает). */
const LIST_LIMIT = 500;
const MAX_NOMINAL = 10_000_000;

const day = z.string().refine(isIsoDate, 'Дата — YYYY-MM-DD');
const comment = z.string().trim().max(1000).nullish();
const issueSchema = z
  .object({
    number: z.string().trim().max(32).optional(),
    nominal: z.number().positive().max(MAX_NOMINAL),
    holderName: z.string().trim().min(1, 'Укажите, на чьё имя сертификат').max(255),
    paidOn: day.nullish(),
    validUntil: day,
    dealId: z.number().int().positive().nullish(),
    comment,
  })
  .strict();
const changeSchema = z.object({ validUntil: day, comment }).strict();
const redeemSchema = z.object({ reason: z.enum(['used', 'expired']), comment }).strict();

/**
 * Сертификаты портала: список, выпуск, изменение срока, погашение. Видят все с доступом к
 * приложению; выпускают, меняют и погашают — администраторы приложения и сотрудники с правом
 * `payment.send` хотя бы в одной группе (те, кто принимает оплату). Каждое действие — в историю
 * сертификата и в журнал действий.
 */
@Injectable()
export class CertificatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly log: ActionLogService,
  ) {}

  async list(user: B24UserContext, query: { q?: unknown; status?: unknown }): Promise<CertificateListDto> {
    const portalId = user.portal.id;
    const today = dateOf(todayIn(user.portal.timezone));
    const q = typeof query.q === 'string' ? query.q.trim().slice(0, 100) : '';
    const status = typeof query.status === 'string' ? query.status : '';
    const where: Prisma.CertificateWhereInput = {
      portalId,
      ...(q ? { OR: [{ number: { contains: q.toUpperCase() } }, { holderName: { contains: q } }] } : {}),
      ...(status === 'overdue'
        ? { status: 'new', validUntil: { lt: today } }
        : CERTIFICATE_STATUSES.includes(status as CertificateStatus)
          ? { status: status as CertificateStatus }
          : {}),
    };
    const [rows, grouped, overdue, canManage] = await Promise.all([
      this.prisma.certificate.findMany({ where, orderBy: { createdAt: 'desc' }, take: LIST_LIMIT + 1 }),
      this.prisma.certificate.groupBy({ by: ['status'], where: { portalId }, _count: { _all: true } }),
      this.prisma.certificate.count({ where: { portalId, status: 'new', validUntil: { lt: today } } }),
      this.canManage(user),
    ]);
    const counts = { all: 0, new: 0, used: 0, expired: 0, overdue };
    for (const g of grouped) {
      counts[g.status] = g._count._all;
      counts.all += g._count._all;
    }
    return { items: rows.slice(0, LIST_LIMIT).map((r) => toDto(r, today)), counts, canManage, truncated: rows.length > LIST_LIMIT };
  }

  async get(user: B24UserContext, id: string): Promise<CertificateDetailsDto> {
    const cert = await this.find(user, id);
    const events = await this.prisma.certificateEvent.findMany({ where: { portalId: user.portal.id, certificateId: id }, orderBy: { at: 'desc' } });
    return { ...toDto(cert, dateOf(todayIn(user.portal.timezone))), events: events.map(toEvent) };
  }

  /** Выпуск: номер — введённый (бумажный бланк) или следующий свободный. */
  async issue(user: B24UserContext, body: unknown): Promise<CertificateDetailsDto> {
    await this.mustManage(user);
    const input = parse(issueSchema, body);
    if (input.number && !CERTIFICATE_NUMBER.test(input.number))
      throw new BadRequestException({ code: 'INVALID_NUMBER', message: 'Номер — буквы, цифры и дефис, до 32 знаков' });
    if (input.paidOn && input.paidOn > input.validUntil)
      throw new BadRequestException({ code: 'INVALID_PERIOD', message: 'Срок действия раньше даты оплаты' });
    const portalId = user.portal.id;
    // Свободный номер может занять параллельный выпуск — тогда следующий (unique по порталу).
    for (let attempt = 0; ; attempt++) {
      const number = input.number ? input.number.toUpperCase() : await this.nextNumber(portalId);
      try {
        const cert = await this.prisma.$transaction(async (tx) => {
          const c = await tx.certificate.create({
            data: {
              portalId,
              number,
              nominal: input.nominal,
              holderName: input.holderName,
              paidOn: input.paidOn ? dateOf(input.paidOn) : null,
              validUntil: dateOf(input.validUntil),
              dealId: input.dealId ?? null,
              comment: input.comment || null,
              createdByUserId: user.userId,
            },
          });
          await tx.certificateEvent.create({
            data: { portalId, certificateId: c.id, action: 'issued', userId: user.userId, userName: user.userName, details: { nominal: input.nominal, validUntil: input.validUntil } },
          });
          return c;
        });
        await this.log.user(user, {
          action: 'certificate.issued',
          summary: `Выпустил сертификат №${number} на ${input.nominal} ₽ (${input.holderName}), действует по ${ru(input.validUntil)}`,
          entityType: 'certificate',
          entityId: number,
          details: { ...input, number },
          via: 'app',
        });
        return this.get(user, cert.id);
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          if (input.number) throw new ConflictException({ code: 'NUMBER_TAKEN', message: `Сертификат №${number} уже есть` });
          if (attempt < 3) continue;
        }
        throw err;
      }
    }
  }

  /** Изменение — срок действия (только у нового сертификата). */
  async change(user: B24UserContext, id: string, body: unknown): Promise<CertificateDetailsDto> {
    await this.mustManage(user);
    const input = parse(changeSchema, body);
    const cert = await this.find(user, id);
    if (cert.status !== 'new')
      throw new ConflictException({ code: 'CERTIFICATE_CLOSED', message: `Сертификат уже погашен (${CERTIFICATE_STATUS_LABELS[cert.status].toLowerCase()}) — срок не меняется` });
    const before = iso(cert.validUntil);
    if (before === input.validUntil) throw new BadRequestException({ code: 'NOTHING_CHANGED', message: 'Срок действия не изменился' });
    if (cert.paidOn && iso(cert.paidOn) > input.validUntil)
      throw new BadRequestException({ code: 'INVALID_PERIOD', message: 'Срок действия раньше даты оплаты' });
    // Условие на статус — в самом обновлении: параллельное погашение не «оживит» сертификат.
    const done = await this.prisma.$transaction(async (tx) => {
      const r = await tx.certificate.updateMany({ where: { id, portalId: user.portal.id, status: 'new' }, data: { validUntil: dateOf(input.validUntil) } });
      if (!r.count) return false;
      await tx.certificateEvent.create({
        data: {
          portalId: user.portal.id,
          certificateId: id,
          action: 'changed',
          userId: user.userId,
          userName: user.userName,
          details: { validUntil: { before, after: input.validUntil }, comment: input.comment || null },
        },
      });
      return true;
    });
    if (!done) throw new ConflictException({ code: 'CERTIFICATE_CLOSED', message: 'Сертификат уже погашен — обновите страницу' });
    await this.log.user(user, {
      action: 'certificate.changed',
      summary: `Изменил срок сертификата №${cert.number}: ${ru(before)} → ${ru(input.validUntil)}`,
      entityType: 'certificate',
      entityId: cert.number,
      details: { before: { validUntil: before }, after: { validUntil: input.validUntil }, comment: input.comment || null },
      via: 'app',
    });
    return this.get(user, id);
  }

  /** Погашение: причина «использован» или «истёк» — она же итоговый статус. Повтор — ошибка, не второе погашение. */
  async redeem(user: B24UserContext, id: string, body: unknown): Promise<CertificateDetailsDto> {
    await this.mustManage(user);
    const input = parse(redeemSchema, body);
    const cert = await this.find(user, id);
    const done = await this.prisma.$transaction(async (tx) => {
      const r = await tx.certificate.updateMany({ where: { id, portalId: user.portal.id, status: 'new' }, data: { status: input.reason, redeemedAt: new Date() } });
      if (!r.count) return false;
      await tx.certificateEvent.create({
        data: { portalId: user.portal.id, certificateId: id, action: 'redeemed', userId: user.userId, userName: user.userName, details: { reason: input.reason, comment: input.comment || null } },
      });
      return true;
    });
    if (!done) throw new ConflictException({ code: 'CERTIFICATE_CLOSED', message: 'Сертификат уже погашен' });
    await this.log.user(user, {
      action: 'certificate.redeemed',
      summary: `Погасил сертификат №${cert.number}: ${CERTIFICATE_STATUS_LABELS[input.reason].toLowerCase()}`,
      entityType: 'certificate',
      entityId: cert.number,
      details: { reason: input.reason, comment: input.comment || null },
      via: 'app',
    });
    return this.get(user, id);
  }

  async canManage(user: B24UserContext): Promise<boolean> {
    const a = await this.access.resolve(user);
    return a.isAppAdmin || a.groups.some((g) => g.permissions.includes('payment.send'));
  }

  private async mustManage(user: B24UserContext): Promise<void> {
    if (!(await this.canManage(user)))
      throw new ForbiddenException({ code: 'NO_CERTIFICATE_ACCESS', message: 'Выпускать и погашать сертификаты могут администраторы и сотрудники, принимающие оплату' });
  }

  /** Сертификат портала пользователя (чужой портал — как несуществующий). */
  private async find(user: B24UserContext, id: string): Promise<Certificate> {
    const cert = await this.prisma.certificate.findFirst({ where: { id, portalId: user.portal.id } });
    if (!cert) throw new NotFoundException({ code: 'CERTIFICATE_NOT_FOUND', message: 'Сертификат не найден' });
    return cert;
  }

  /** Следующий номер: наибольший чисто цифровой + 1, шесть знаков («000124»). */
  private async nextNumber(portalId: string): Promise<string> {
    const rows = await this.prisma.$queryRaw<{ n: bigint | number | null }[]>`
      SELECT MAX(CAST(number AS UNSIGNED)) AS n FROM Certificate WHERE portalId = ${portalId} AND number REGEXP '^[0-9]+$'`;
    return String(Number(rows[0]?.n ?? 0) + 1).padStart(6, '0');
  }
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const p = schema.safeParse(body);
  if (!p.success) throw new BadRequestException({ code: 'INVALID_CERTIFICATE', message: p.error.issues[0]?.message ?? 'Неверные данные сертификата' });
  return p.data;
}

/** Дата портала → значение колонки DATE (полночь UTC). */
const dateOf = (d: string) => new Date(`${d}T00:00:00.000Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const ru = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;

function toDto(c: Certificate, today: Date): CertificateDto {
  return {
    id: c.id,
    number: c.number,
    nominal: Number(c.nominal),
    holderName: c.holderName,
    status: c.status,
    paidOn: c.paidOn ? iso(c.paidOn) : null,
    validUntil: iso(c.validUntil),
    overdue: c.status === 'new' && c.validUntil < today,
    dealId: c.dealId,
    comment: c.comment,
    createdAt: c.createdAt.toISOString(),
    redeemedAt: c.redeemedAt?.toISOString() ?? null,
  };
}

function toEvent(e: CertificateEvent): CertificateEventDto {
  const d = (e.details ?? {}) as Record<string, unknown>;
  const action = e.action as CertificateAction;
  const note = typeof d.comment === 'string' && d.comment ? ` · ${d.comment}` : '';
  let text = '';
  if (action === 'issued') text = `номинал ${Number(d.nominal ?? 0).toLocaleString('ru-RU')} ₽, действует по ${ru(String(d.validUntil ?? ''))}`;
  else if (action === 'changed') {
    const v = d.validUntil as { before?: string; after?: string } | undefined;
    text = `срок ${ru(String(v?.before ?? ''))} → ${ru(String(v?.after ?? ''))}${note}`;
  } else if (action === 'redeemed') text = `причина: ${CERTIFICATE_STATUS_LABELS[(d.reason as CertificateStatus) ?? 'used']?.toLowerCase() ?? d.reason}${note}`;
  return { id: e.id, action, at: e.at.toISOString(), userName: e.userName, text };
}
