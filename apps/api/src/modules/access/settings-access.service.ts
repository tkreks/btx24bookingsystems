import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomInt } from 'node:crypto';
import type { SettingsCodeCreatedDto, SettingsCodeDto } from '@btx24/shared';
import type { SettingsAccessCode } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';

/** Без похожих символов (0/O, 1/I/L): код диктуют голосом и переписывают руками. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 10;
export const MAX_HOURS = 72;
/** Неверных попыток подряд — и пауза. */
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;

export function newCode(): string {
  return Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
}

/** Ввод без учёта регистра, пробелов и дефисов. */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '');
}

export const hashCode = (portalId: string, code: string) =>
  createHash('sha256').update(`${portalId}:${normalizeCode(code)}`).digest('hex');

/**
 * Временный доступ к настройкам: постоянный администратор создаёт одноразовый пароль на N часов,
 * сотрудник его вводит — и до конца срока работает как администратор приложения.
 */
@Injectable()
export class SettingsAccessService {
  /** portalId:userId → неудачные попытки (в памяти процесса api). */
  private readonly failures = new Map<string, { count: number; lockedUntil: number }>();

  constructor(private readonly prisma: PrismaService) {}

  async create(user: B24UserContext, body: unknown, now = new Date()): Promise<SettingsCodeCreatedDto> {
    const hours = Number((body as { hours?: unknown } | null)?.hours);
    if (!Number.isInteger(hours) || hours < 1 || hours > MAX_HOURS)
      throw new BadRequestException({ code: 'INVALID_HOURS', message: `Срок — от 1 до ${MAX_HOURS} часов` });
    const code = newCode();
    const row = await this.prisma.settingsAccessCode.create({
      data: {
        portalId: user.portal.id,
        codeHash: hashCode(user.portal.id, code),
        createdByUserId: user.userId,
        expiresAt: new Date(now.getTime() + hours * 3600_000),
      },
    });
    return { id: row.id, code, expiresAt: row.expiresAt.toISOString() };
  }

  async list(portalId: string): Promise<SettingsCodeDto[]> {
    const rows = await this.prisma.settingsAccessCode.findMany({ where: { portalId }, orderBy: { createdAt: 'desc' }, take: 50 });
    return rows.map(toDto);
  }

  /** Отзыв: неиспользованный пароль больше не сработает, выданный доступ прекращается. */
  async revoke(portalId: string, id: string): Promise<SettingsCodeDto> {
    const row = await this.prisma.settingsAccessCode.findFirst({ where: { id, portalId } });
    if (!row) throw new NotFoundException({ code: 'CODE_NOT_FOUND', message: 'Пароль не найден' });
    return toDto(await this.prisma.settingsAccessCode.update({ where: { id }, data: { revokedAt: row.revokedAt ?? new Date() } }));
  }

  /** Активировать пароль для себя. Неверный, использованный, отозванный и истёкший — одинаково «неверный». */
  async activate(user: B24UserContext, body: unknown, now = new Date()): Promise<{ until: string }> {
    const key = `${user.portal.id}:${user.userId}`;
    const f = this.failures.get(key);
    if (f && f.lockedUntil > now.getTime())
      throw new HttpException(
        { code: 'TOO_MANY_ATTEMPTS', message: 'Слишком много неверных попыток — попробуйте через 15 минут' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    const code = String((body as { code?: unknown } | null)?.code ?? '');
    const hash = hashCode(user.portal.id, code);
    // Атомарно: использовать может только первый (повторная активация тем же сотрудником — ок).
    const { count } = await this.prisma.settingsAccessCode.updateMany({
      where: {
        portalId: user.portal.id,
        codeHash: hash,
        revokedAt: null,
        expiresAt: { gt: now },
        OR: [{ usedByUserId: null }, { usedByUserId: user.userId }],
      },
      data: { usedByUserId: user.userId, usedAt: now },
    });
    if (!count) {
      const next = { count: (f && f.lockedUntil <= now.getTime() && f.count >= MAX_FAILURES ? 0 : (f?.count ?? 0)) + 1, lockedUntil: 0 };
      if (next.count >= MAX_FAILURES) next.lockedUntil = now.getTime() + LOCK_MS;
      this.failures.set(key, next);
      throw new ForbiddenException({ code: 'INVALID_CODE', message: 'Пароль неверный, уже использован или истёк' });
    }
    this.failures.delete(key);
    const row = await this.prisma.settingsAccessCode.findFirst({ where: { portalId: user.portal.id, codeHash: hash } });
    return { until: row!.expiresAt.toISOString() };
  }
}

function toDto(r: SettingsAccessCode): SettingsCodeDto {
  return {
    id: r.id,
    createdByUserId: r.createdByUserId,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    usedByUserId: r.usedByUserId,
    usedAt: r.usedAt?.toISOString() ?? null,
    revokedAt: r.revokedAt?.toISOString() ?? null,
  };
}
