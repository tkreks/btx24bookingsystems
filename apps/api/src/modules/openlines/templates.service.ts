import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { MessageTemplateDto, TemplateStepDto } from '@btx24/shared';
import { z } from 'zod';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { FilesService } from './files.service.js';

/** Шаг цепочки: текст до 4000 символов и до 10 вложений; пустой шаг не допускается. */
export const stepsSchema = z
  .array(
    z
      .object({ text: z.string().max(4000), fileIds: z.array(z.string().min(1).max(40)).max(10) })
      .strict()
      .refine((s) => s.text.trim().length > 0 || s.fileIds.length > 0),
  )
  .min(1)
  .max(20);

const templateSchema = z.object({ name: z.string().trim().min(1).max(100), steps: stepsSchema }).strict();
const MAX_TEMPLATES = 100;

/** Личные шаблоны сообщений: видит и меняет только автор (портал + сотрудник Битрикс24). */
@Injectable()
export class TemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
  ) {}

  async list(user: B24UserContext): Promise<MessageTemplateDto[]> {
    const rows = await this.prisma.messageTemplate.findMany({
      where: { portalId: user.portal.id, ownerUserId: user.userId },
      orderBy: { name: 'asc' },
    });
    const steps = rows.map((r) => r.steps as unknown as TemplateStepDto[]);
    const meta = await this.files.meta(user, [...new Set(steps.flat().flatMap((s) => s.fileIds))]);
    return rows.map((r, i) => ({
      id: r.id,
      name: r.name,
      updatedAt: r.updatedAt.toISOString(),
      steps: steps[i].map((s) => ({ ...s, files: s.fileIds.flatMap((id) => (meta.has(id) ? [meta.get(id)!] : [])) })),
    }));
  }

  async create(user: B24UserContext, body: unknown): Promise<MessageTemplateDto> {
    const data = await this.validate(user, body);
    const count = await this.prisma.messageTemplate.count({
      where: { portalId: user.portal.id, ownerUserId: user.userId },
    });
    if (count >= MAX_TEMPLATES)
      throw new BadRequestException({ code: 'TOO_MANY_TEMPLATES', message: `Не больше ${MAX_TEMPLATES} шаблонов` });
    const row = await this.prisma.messageTemplate.create({
      data: { portalId: user.portal.id, ownerUserId: user.userId, name: data.name, steps: data.steps },
    });
    return this.one(user, row.id);
  }

  async update(user: B24UserContext, id: string, body: unknown): Promise<MessageTemplateDto> {
    const data = await this.validate(user, body);
    const before = await this.owned(user, id);
    await this.prisma.messageTemplate.updateMany({
      where: { id, portalId: user.portal.id, ownerUserId: user.userId },
      data: { name: data.name, steps: data.steps },
    });
    await this.files.dropUnused(user, fileIds(before.steps));
    return this.one(user, id);
  }

  async remove(user: B24UserContext, id: string): Promise<void> {
    const before = await this.owned(user, id);
    await this.prisma.messageTemplate.deleteMany({ where: { id, portalId: user.portal.id, ownerUserId: user.userId } });
    await this.files.dropUnused(user, fileIds(before.steps));
  }

  private async validate(user: B24UserContext, body: unknown) {
    const parsed = templateSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException({
        code: 'INVALID_TEMPLATE',
        message: 'Нужно название (до 100 символов) и от 1 до 20 сообщений с текстом или вложением',
      });
    await this.files.assertOwned(user, [...new Set(parsed.data.steps.flatMap((s) => s.fileIds))]);
    return parsed.data;
  }

  private async owned(user: B24UserContext, id: string) {
    const row = await this.prisma.messageTemplate.findFirst({
      where: { id, portalId: user.portal.id, ownerUserId: user.userId },
    });
    if (!row) throw new NotFoundException({ code: 'TEMPLATE_NOT_FOUND', message: 'Шаблон не найден' });
    return row;
  }

  private async one(user: B24UserContext, id: string): Promise<MessageTemplateDto> {
    const found = (await this.list(user)).find((t) => t.id === id);
    if (!found) throw new NotFoundException({ code: 'TEMPLATE_NOT_FOUND', message: 'Шаблон не найден' });
    return found;
  }
}

const fileIds = (steps: unknown) => ((steps as TemplateStepDto[]) ?? []).flatMap((s) => s.fileIds ?? []);
