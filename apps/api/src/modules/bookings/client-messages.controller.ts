import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseIntPipe, Put, Query, UseGuards } from '@nestjs/common';
import type { BizprocImportDto, ClientFileRef, DiskItemDto, ResourceAdminDto } from '@btx24/shared';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AppAdminGuard } from '../access/app-admin.guard.js';
import { B24AuthGuard, B24User } from '../bitrix24/auth/b24-auth.guard.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { Bitrix24Error } from '../bitrix24/rest/errors.js';
import { rulesFromBizproc } from './bizproc-import.js';
import { DealFieldMapService } from './deal-field-map.service.js';

const clientNameSchema = z.object({ clientName: z.string().trim().max(255).nullable() }).strict();
const diskQuery = z
  .object({ storageId: z.coerce.number().int().positive().optional(), folderId: z.coerce.number().int().positive().optional() })
  .strict();

interface RawDiskItem {
  ID: string | number;
  NAME?: string;
  TYPE?: string;
  SIZE?: string | number | null;
}

/**
 * Настройки сообщений клиенту (администраторы приложения): имена ресурсов для клиента, выбор
 * файлов с Диска и перенос правил из БП. Чтение Битрикс24 — токеном администратора (его права).
 */
@Controller('admin')
@UseGuards(B24AuthGuard, AppAdminGuard)
export class ClientMessagesAdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fieldMap: DealFieldMapService,
  ) {}

  @Get('resources')
  async resources(@B24User() user: B24UserContext): Promise<ResourceAdminDto[]> {
    const rows = await this.prisma.resource.findMany({ where: { portalId: user.portal.id } });
    return rows
      .map((r) => ({ resourceId: r.resourceId, name: r.name, clientName: r.clientName, archived: r.archivedAt !== null }))
      .sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name, 'ru', { numeric: true }));
  }

  /** Альтернативное имя ресурса для клиента; пусто — как в Битрикс24. */
  @Put('resources/:resourceId')
  async rename(
    @B24User() user: B24UserContext,
    @Param('resourceId', ParseIntPipe) resourceId: number,
    @Body() body: unknown,
  ): Promise<ResourceAdminDto> {
    const parsed = clientNameSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ code: 'INVALID_NAME', message: 'Имя — до 255 символов' });
    const existing = await this.prisma.resource.findUnique({
      where: { portalId_resourceId: { portalId: user.portal.id, resourceId } },
    });
    if (!existing) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND', message: 'Ресурс ещё не синхронизирован' });
    const r = await this.prisma.resource.update({
      where: { id: existing.id },
      data: { clientName: parsed.data.clientName || null },
    });
    return { resourceId: r.resourceId, name: r.name, clientName: r.clientName, archived: r.archivedAt !== null };
  }

  /** Без параметров — хранилища; `storageId` — корень хранилища; `folderId` — папка. */
  @Get('disk')
  async disk(@B24User() user: B24UserContext, @Query() query: unknown): Promise<DiskItemDto[]> {
    const q = diskQuery.safeParse(query);
    if (!q.success) throw new BadRequestException({ code: 'INVALID_QUERY', message: 'storageId или folderId' });
    try {
      if (!q.data.storageId && !q.data.folderId) {
        const res = await user.client.call<RawDiskItem[]>('disk.storage.getlist');
        return (res.result ?? []).map((s) => ({ kind: 'storage', id: Number(s.ID), name: s.NAME ?? `Хранилище ${s.ID}`, size: null }));
      }
      const res = q.data.folderId
        ? await user.client.call<RawDiskItem[]>('disk.folder.getchildren', { id: q.data.folderId })
        : await user.client.call<RawDiskItem[]>('disk.storage.getchildren', { id: q.data.storageId });
      return (res.result ?? [])
        .map((x): DiskItemDto => ({
          kind: x.TYPE === 'folder' ? 'folder' : 'file',
          id: Number(x.ID),
          name: x.NAME ?? `#${x.ID}`,
          size: x.SIZE === null || x.SIZE === undefined ? null : Number(x.SIZE),
        }))
        .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'ru', { numeric: true }) : a.kind === 'folder' ? -1 : 1));
    } catch (err) {
      if (err instanceof Bitrix24Error && /scope/i.test(`${err.code} ${err.message}`))
        throw new BadRequestException({
          code: 'NO_DISK_SCOPE',
          message: 'У приложения нет доступа к Диску: добавьте право «Диск» (disk) и переустановите приложение',
        });
      throw err;
    }
  }

  /** Типы брони и сообщения из БП (шаблон сделки), для подстановки в форму группы — без сохранения. */
  @Get('bizproc-import')
  async bizproc(@B24User() user: B24UserContext, @Query('templateId') templateId?: string): Promise<BizprocImportDto> {
    const id = Number(templateId);
    if (!Number.isInteger(id) || id <= 0) throw new BadRequestException({ code: 'INVALID_TEMPLATE', message: 'templateId — номер БП' });
    const res = await user.client.call<{ NAME?: string; TEMPLATE?: unknown }[]>('bizproc.workflow.template.list', {
      SELECT: ['ID', 'NAME', 'TEMPLATE'],
      FILTER: { ID: id },
    });
    const t = res.result?.[0];
    if (!t) throw new NotFoundException({ code: 'TEMPLATE_NOT_FOUND', message: `БП ${id} не найден` });
    const rules = rulesFromBizproc(t.TEMPLATE);
    // Значения «Тип бронирования» в БП — внутренние коды вариантов; для REST нужны номера.
    const field = (await this.fieldMap.get(user.portal.id)).bookingType;
    if (field)
      for (const r of rules)
        if (r.dealTypeValue) r.dealTypeValue = (await this.fieldMap.enumId(user.portal.id, user.client, field, r.dealTypeValue).catch(() => null)) ?? r.dealTypeValue;
    await this.fileNames(user, rules.flatMap((r) => r.confirmation.flatMap((s) => s.files)));
    return { templateName: t.NAME ?? `БП ${id}`, rules };
  }

  /** Подставить настоящие имена файлов Диска (если у приложения есть доступ к Диску). */
  private async fileNames(user: B24UserContext, files: ClientFileRef[]): Promise<void> {
    const diskFiles = files.filter((f) => 'id' in f);
    const ids = [...new Set(diskFiles.map((f) => f.id))];
    if (!ids.length) return;
    try {
      const res = await user.client.batch(Object.fromEntries(ids.map((id) => [`f${id}`, { method: 'disk.file.get', params: { id } }])));
      for (const f of diskFiles) {
        const name = (res.result[`f${f.id}`] as { NAME?: string } | undefined)?.NAME;
        if (name) f.name = name;
      }
    } catch {
      /* без доступа к Диску остаются «Файл Диска #id» */
    }
  }
}
