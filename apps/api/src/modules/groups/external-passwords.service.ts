import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { ExternalUserSummaryDto } from '@btx24/shared';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service.js';
import { hashPassword } from '../external-users/password.js';

const passwordSchema = z.object({ password: z.string().min(12).max(128) }).strict();
@Injectable()
export class ExternalPasswordsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(portalId: string): Promise<ExternalUserSummaryDto[]> {
    const users = await this.prisma.externalUser.findMany({
      where: { portalId },
      select: { id: true, login: true, role: true, disabledAt: true },
      orderBy: { login: 'asc' },
    });
    return users.map((u) => ({ id: u.id, login: u.login, role: u.role, disabled: u.disabledAt !== null }));
  }

  async change(portalId: string, id: string, body: unknown): Promise<void> {
    const parsed = passwordSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException({
        code: 'INVALID_PASSWORD',
        message: 'Пароль должен содержать от 12 до 128 символов; разрешено только поле password',
      });
    const user = await this.prisma.externalUser.findFirst({ where: { id, portalId }, select: { id: true } });
    if (!user) throw new NotFoundException({ code: 'EXTERNAL_USER_NOT_FOUND', message: 'Пользователь не найден' });
    const passwordHash = await hashPassword(parsed.data.password);
    const result = await this.prisma.externalUser.updateMany({ where: { id, portalId }, data: { passwordHash, failedLogins: 0, lockedUntil: null } });
    if (!result.count)
      throw new NotFoundException({ code: 'EXTERNAL_USER_NOT_FOUND', message: 'Пользователь не найден' });
    // Новый пароль (пауза после неудач снята выше) — входы со старым паролем завершаются.
    await this.prisma.externalSession.deleteMany({ where: { portalId, externalUserId: id } });
  }
}
