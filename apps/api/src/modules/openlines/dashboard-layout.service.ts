import { BadRequestException, Injectable } from '@nestjs/common';
import { allowedBlocks, BLOCK_WIDTHS, DEFAULT_DASHBOARD, type DashboardBlock, type DashboardLayoutDto } from '@btx24/shared';
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';

const MAX_BLOCKS = 40;

/**
 * Личный дашборд (решение владельца 2026-10-24): блоки по порядку и их ширина — у каждого сотрудника
 * свои. Блоки «только администраторам» (активность сотрудников) у остальных отбрасываются и при
 * чтении (сотрудник перестал быть администратором), и при сохранении.
 */
@Injectable()
export class DashboardLayoutService {
  constructor(private readonly prisma: PrismaService) {}

  async get(user: B24UserContext, isAppAdmin: boolean): Promise<DashboardLayoutDto> {
    const row = await this.prisma.dashboardLayout.findUnique({ where: { portalId_userId: { portalId: user.portal.id, userId: user.userId } } });
    const allowed = new Set(allowedBlocks(isAppAdmin));
    const blocks = row ? clean(row.blocks, allowed) : DEFAULT_DASHBOARD.filter((b) => allowed.has(b.type));
    return { blocks, isDefault: !row };
  }

  async save(user: B24UserContext, isAppAdmin: boolean, body: unknown): Promise<DashboardLayoutDto> {
    const allowed = allowedBlocks(isAppAdmin);
    const schema = z
      .object({
        blocks: z
          .array(z.object({ id: z.string().min(1).max(40), type: z.enum(allowed as [string, ...string[]]), width: z.enum(BLOCK_WIDTHS), rows: z.union([z.literal(1), z.literal(2)]).optional() }).strict())
          .max(MAX_BLOCKS),
      })
      .strict();
    const p = schema.safeParse(body);
    if (!p.success) throw new BadRequestException({ code: 'INVALID_LAYOUT', message: 'Неверная раскладка дашборда (или блок недоступен)' });
    // Один тип — один раз (первый остаётся).
    const seen = new Set<string>();
    const blocks = (p.data.blocks as DashboardBlock[]).filter((b) => (seen.has(b.type) ? false : (seen.add(b.type), true)));
    await this.prisma.dashboardLayout.upsert({
      where: { portalId_userId: { portalId: user.portal.id, userId: user.userId } },
      create: { portalId: user.portal.id, userId: user.userId, blocks: blocks as unknown as Prisma.InputJsonValue },
      update: { blocks: blocks as unknown as Prisma.InputJsonValue },
    });
    return { blocks, isDefault: false };
  }

  /** «Сбросить»: раскладка по умолчанию. */
  async reset(user: B24UserContext, isAppAdmin: boolean): Promise<DashboardLayoutDto> {
    await this.prisma.dashboardLayout.deleteMany({ where: { portalId: user.portal.id, userId: user.userId } });
    return this.get(user, isAppAdmin);
  }
}

function clean(raw: unknown, allowed: Set<string>): DashboardBlock[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw.filter(
    (b): b is DashboardBlock =>
      !!b && typeof b === 'object' && allowed.has((b as DashboardBlock).type) && (BLOCK_WIDTHS as readonly string[]).includes((b as DashboardBlock).width) && !seen.has((b as DashboardBlock).type) && !!seen.add((b as DashboardBlock).type),
  );
}
