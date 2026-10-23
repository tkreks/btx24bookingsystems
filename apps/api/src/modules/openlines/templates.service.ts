import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { GroupOptionsDto, MessageTemplateDto, TemplateStepDto } from '@btx24/shared';
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

const templateSchema = z
  .object({ name: z.string().trim().min(1).max(100), steps: stepsSchema, shared: z.boolean().optional(), purpose: z.enum(['chat', 'payment', 'auto']).optional() })
  .strict();
const MAX_TEMPLATES = 100;

/**
 * Шаблоны сообщений: личные (видит и меняет автор) и общие (видят все сотрудники портала, меняют
 * администраторы приложения). `admin` — администратор приложения (решает контроллер через AccessService).
 * Шаблон оплаты (`purpose: payment`) — системный: всегда общий, его выбирает группа для сообщения
 * со ссылкой на предоплату/доплату; пока он выбран в группе, удалить его нельзя.
 */
@Injectable()
export class TemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
  ) {}

  async list(user: B24UserContext, admin = false): Promise<MessageTemplateDto[]> {
    const rows = await this.prisma.messageTemplate.findMany({
      where: { portalId: user.portal.id, OR: [{ ownerUserId: user.userId }, { shared: true }] },
      orderBy: [{ shared: 'desc' }, { name: 'asc' }],
    });
    const steps = rows.map((r) => r.steps as unknown as TemplateStepDto[]);
    const meta = await this.files.meta(user, [...new Set(steps.flat().flatMap((s) => s.fileIds))]);
    return rows.map((r, i) => ({
      id: r.id,
      name: r.name,
      shared: r.shared,
      purpose: r.purpose,
      mine: r.ownerUserId === user.userId,
      canEdit: r.shared ? admin : r.ownerUserId === user.userId,
      updatedAt: r.updatedAt.toISOString(),
      steps: steps[i].map((s) => ({ ...s, files: s.fileIds.flatMap((id) => (meta.has(id) ? [meta.get(id)!] : [])) })),
    }));
  }

  async create(user: B24UserContext, body: unknown, admin = false): Promise<MessageTemplateDto> {
    const data = await this.validate(user, body, admin);
    const count = await this.prisma.messageTemplate.count({
      where: { portalId: user.portal.id, ownerUserId: user.userId },
    });
    if (count >= MAX_TEMPLATES)
      throw new BadRequestException({ code: 'TOO_MANY_TEMPLATES', message: `Не больше ${MAX_TEMPLATES} шаблонов` });
    const row = await this.prisma.messageTemplate.create({
      data: { portalId: user.portal.id, ownerUserId: user.userId, name: data.name, steps: data.steps, shared: data.shared ?? false, purpose: data.purpose ?? 'chat' },
    });
    return this.one(user, row.id, admin);
  }

  async update(user: B24UserContext, id: string, body: unknown, admin = false): Promise<MessageTemplateDto> {
    const before = await this.editable(user, id, admin);
    const data = await this.validate(user, body, admin, fileIds(before.steps));
    // Системный шаблон (оплата, рассылка) сменил назначение — проверяем, что он нигде не выбран.
    if (before.purpose !== 'chat' && data.purpose !== undefined && data.purpose !== before.purpose) await this.assertUnused(user, before.id, before.name);
    await this.prisma.messageTemplate.update({
      where: { id: before.id },
      data: {
        name: data.name,
        steps: data.steps,
        ...((data.purpose ?? before.purpose) !== 'chat' ? { shared: true } : data.shared === undefined ? {} : { shared: data.shared }),
        ...(data.purpose === undefined ? {} : { purpose: data.purpose }),
      },
    });
    await this.files.dropUnused(user, fileIds(before.steps));
    return this.one(user, id, admin);
  }

  async remove(user: B24UserContext, id: string, admin = false): Promise<void> {
    const before = await this.editable(user, id, admin);
    if (before.purpose !== 'chat') await this.assertUnused(user, before.id, before.name);
    await this.prisma.messageTemplate.delete({ where: { id: before.id } });
    await this.files.dropUnused(user, fileIds(before.steps));
  }

  private async validate(user: B24UserContext, body: unknown, admin: boolean, keep: string[] = []) {
    const parsed = templateSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException({
        code: 'INVALID_TEMPLATE',
        message: 'Нужно название (до 100 символов) и от 1 до 20 сообщений с текстом или вложением',
      });
    const system = parsed.data.purpose === 'payment' || parsed.data.purpose === 'auto';
    if ((parsed.data.shared || system) && !admin)
      throw new ForbiddenException({ code: 'SHARED_TEMPLATES_ADMIN_ONLY', message: 'Общие шаблоны меняют только администраторы приложения' });
    // Шаблоны оплаты и рассылок — системные: всегда общие (их отправляет автоматизация от имени любого сотрудника).
    if (system) parsed.data.shared = true;
    // Файлы — свои или уже бывшие в этом шаблоне (общий шаблон мог собрать другой администратор).
    await this.files.assertOwned(user, [...new Set(parsed.data.steps.flatMap((s) => s.fileIds))].filter((id) => !keep.includes(id)));
    return parsed.data;
  }

  /** Системный шаблон, выбранный в группе (оплата, рассылка), не удаляем: сообщение молча сменилось бы или пропало. */
  private async assertUnused(user: B24UserContext, id: string, name: string): Promise<void> {
    const groups = await this.prisma.workGroup.findMany({ where: { portalId: user.portal.id, archivedAt: null }, select: { name: true, options: true } });
    const used = groups.flatMap((g) => {
      const o = g.options as GroupOptionsDto | null;
      const p = o?.payments;
      return [
        p?.prepaymentTemplateId === id ? `${g.name} (предоплата)` : null,
        p?.surchargeTemplateId === id ? `${g.name} (доплата)` : null,
        ...(o?.autoMessages ?? []).filter((r) => r.templateId === id).map((r) => `${g.name} (рассылка «${r.name}»)`),
      ].filter((x): x is string => !!x);
    });
    if (used.length)
      throw new ConflictException({
        code: 'TEMPLATE_IN_USE',
        message: `Шаблон «${name}» выбран в группах: ${used.join(', ')} — сначала выберите там другой шаблон`,
      });
  }

  /** Свой личный шаблон или общий (администратору); иначе 404 / 403. */
  private async editable(user: B24UserContext, id: string, admin: boolean) {
    const row = await this.prisma.messageTemplate.findFirst({
      where: { id, portalId: user.portal.id, OR: [{ ownerUserId: user.userId }, { shared: true }] },
    });
    if (!row) throw new NotFoundException({ code: 'TEMPLATE_NOT_FOUND', message: 'Шаблон не найден' });
    if (row.shared && !admin)
      throw new ForbiddenException({ code: 'SHARED_TEMPLATES_ADMIN_ONLY', message: 'Общие шаблоны меняют только администраторы приложения' });
    return row;
  }

  private async one(user: B24UserContext, id: string, admin: boolean): Promise<MessageTemplateDto> {
    const found = (await this.list(user, admin)).find((t) => t.id === id);
    if (!found) throw new NotFoundException({ code: 'TEMPLATE_NOT_FOUND', message: 'Шаблон не найден' });
    return found;
  }
}

const fileIds = (steps: unknown) => ((steps as TemplateStepDto[]) ?? []).flatMap((s) => s.fileIds ?? []);
