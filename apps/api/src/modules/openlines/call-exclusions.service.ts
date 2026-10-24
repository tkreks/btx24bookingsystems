import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Звонки, исключённые из статистики дашборда (внутренний тест, ошибочный звонок): не попадают в
 * показатели, упущенные, графики и списки звонков. Исключает администратор приложения, с причиной;
 * вернуть — снять исключение. Сам звонок в Битрикс24 не меняется.
 */
@Injectable()
export class CallExclusionsService {
  constructor(private readonly prisma: PrismaService) {}

  async ids(portalId: string): Promise<Set<number>> {
    const rows = await this.prisma.callExclusion.findMany({ where: { portalId }, select: { activityId: true } });
    return new Set(rows.map((r) => r.activityId));
  }

  /** Строки звонков без исключённых (`ID` — дело CRM). */
  async filter<T extends { ID: string | number }>(portalId: string, rows: T[]): Promise<T[]> {
    if (!rows.length) return rows;
    const ids = await this.ids(portalId);
    return ids.size ? rows.filter((r) => !ids.has(Number(r.ID))) : rows;
  }

  /** Повтор с тем же звонком — обновляет причину (безопасно к повтору). */
  async exclude(portalId: string, userId: number, activityId: number, reason: unknown): Promise<void> {
    const text = typeof reason === 'string' ? reason.trim().slice(0, 500) : '';
    if (!Number.isSafeInteger(activityId) || activityId < 1) throw new BadRequestException({ code: 'INVALID_CALL', message: 'Неверный звонок' });
    if (!text) throw new BadRequestException({ code: 'REASON_REQUIRED', message: 'Укажите причину' });
    await this.prisma.callExclusion.upsert({
      where: { portalId_activityId: { portalId, activityId } },
      create: { portalId, activityId, reason: text, userId },
      update: { reason: text, userId },
    });
  }

  async restore(portalId: string, activityId: number): Promise<void> {
    await this.prisma.callExclusion.deleteMany({ where: { portalId, activityId } });
  }
}
