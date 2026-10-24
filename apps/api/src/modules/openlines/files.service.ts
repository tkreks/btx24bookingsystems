import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { StoredFileDto, DiskItemDto, DiskBrowseDto, GroupOptionsDto } from '@btx24/shared';
import { z } from 'zod';
import { Bitrix24Error } from '../bitrix24/rest/errors.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/** Предел файла вложения (Битрикс24 принимает до 100 МБ, но файл хранится у нас в БД). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Разовые вложения (не в шаблоне) живут сутки — потом удаляются при следующей загрузке. */
const ORPHAN_TTL_MS = 24 * 3600_000;

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/** Файлы вложений менеджера: только автор (портал + сотрудник) видит и использует свои файлы. */
@Injectable()
export class FilesService {
  constructor(private readonly prisma: PrismaService) {}

  async upload(user: B24UserContext, file: UploadedFile | undefined): Promise<StoredFileDto> {
    if (!file?.buffer?.length) throw new BadRequestException({ code: 'FILE_REQUIRED', message: 'Файл не передан' });
    if (file.size > MAX_FILE_BYTES)
      throw new BadRequestException({ code: 'FILE_TOO_LARGE', message: 'Файл больше 10 МБ' });
    await this.dropStale(user);
    // multer отдаёт имя в latin1 — возвращаем UTF-8 (кириллица в именах файлов).
    const name = Buffer.from(file.originalname, 'latin1').toString('utf8').slice(0, 255) || 'file';
    const row = await this.prisma.storedFile.create({
      data: {
        portalId: user.portal.id,
        ownerUserId: user.userId,
        name,
        mime: (file.mimetype || 'application/octet-stream').slice(0, 150),
        size: file.size,
        data: new Uint8Array(file.buffer),
      },
      select: { id: true, name: true, mime: true, size: true },
    });
    return row;
  }

  /** Обзор Диска правами сотрудника, по страницам: на портале тысячи хранилищ. */
  async disk(user: B24UserContext, query: unknown): Promise<DiskBrowseDto> {
    const q = z.object({ storageId: z.coerce.number().int().positive().optional(), folderId: z.coerce.number().int().positive().optional(), offset: z.coerce.number().int().min(0).max(1000000).default(0), q: z.string().trim().max(100).optional() }).strict().refine((x) => !(x.storageId && x.folderId)).safeParse(query);
    if (!q.success) throw new BadRequestException({ code: 'INVALID_QUERY', message: 'Укажите storageId либо folderId' });
    const { storageId, folderId, offset, q: search } = q.data;
    try {
      const res = await user.client.call<{ ID: string; NAME?: string; TYPE?: string; SIZE?: string; DELETED_TYPE?: string }[]>(folderId ? 'disk.folder.getChildren' : storageId ? 'disk.storage.getChildren' : 'disk.storage.getList', { ...(folderId || storageId ? { id: folderId ?? storageId } : {}), order: { NAME: 'ASC', ID: 'ASC' }, start: offset, ...(search ? { filter: { NAME: `%${search}%` } } : {}) });
      const rows = res.result ?? [];
      return { nextOffset: res.next ?? null, items: rows.filter((r) => !r.DELETED_TYPE || r.DELETED_TYPE === '0').map((r): DiskItemDto => ({ id: Number(r.ID), name: r.NAME ?? `#${r.ID}`, kind: !folderId && !storageId ? 'storage' : r.TYPE === 'folder' ? 'folder' : 'file', size: r.SIZE === undefined ? null : Number(r.SIZE) })).sort((a,b) => Number(b.kind === 'folder') - Number(a.kind === 'folder') || a.name.localeCompare(b.name, 'ru', { numeric: true })) };
    } catch (err) { throw this.diskError(err); }
  }

  /** Сохраняем копию: автоматическая отправка не зависит от прав будущего отправителя на Диск. */
  async importDisk(user: B24UserContext, body: unknown): Promise<StoredFileDto> {
    const q = z.object({ fileId: z.number().int().positive() }).strict().safeParse(body);
    if (!q.success) throw new BadRequestException({ code: 'INVALID_FILE', message: 'Укажите файл Диска' });
    try {
      const f = (await user.client.call<{ NAME?: string; SIZE?: string; TYPE?: string; DELETED_TYPE?: string; DOWNLOAD_URL?: string }>('disk.file.get', { id: q.data.fileId })).result;
      if (!f?.DOWNLOAD_URL || f.TYPE !== 'file' || (f.DELETED_TYPE && f.DELETED_TYPE !== '0')) throw new NotFoundException({ code: 'FILE_NOT_FOUND', message: 'Файл Диска не найден' });
      if (Number(f.SIZE) > MAX_FILE_BYTES) throw new BadRequestException({ code: 'FILE_TOO_LARGE', message: 'Файл больше 10 МБ' });
      const { data, contentType } = await user.client.download(f.DOWNLOAD_URL, MAX_FILE_BYTES);
      if (!data.length) throw new BadRequestException({ code: 'FILE_REQUIRED', message: 'Файл пустой' });
      await this.dropStale(user);
      return await this.prisma.storedFile.create({ data: { portalId: user.portal.id, ownerUserId: user.userId, name: (f.NAME || 'file').slice(0,255), mime: (contentType || 'application/octet-stream').slice(0,150), size: data.length, data: new Uint8Array(data) }, select: { id: true, name: true, mime: true, size: true } });
    } catch (err) { throw this.diskError(err); }
  }

  private diskError(err: unknown): unknown {
    if (err instanceof Bitrix24Error) {
      if (/scope/i.test(err.code)) return new BadRequestException({ code: 'NO_DISK_SCOPE', message: 'Для выбора файлов добавьте приложению право «Диск» (disk) в Битрикс24' });
      if (err.code === 'FILE_TOO_LARGE') return new BadRequestException({ code: 'FILE_TOO_LARGE', message: 'Файл больше 10 МБ' });
    }
    return err;
  }

  /** Копии вложений подтверждений сохраняются вместе с настройками групп. */
  private async groupFileIds(portalId: string): Promise<Set<string>> {
    const groups = await this.prisma.workGroup.findMany({ where: { portalId }, select: { options: true } });
    return new Set(groups.flatMap((g) => ((g.options as GroupOptionsDto | null)?.bookingTypes ?? []).flatMap((r) => r.confirmation.flatMap((s) => s.files.flatMap((f) => 'storedFileId' in f ? [f.storedFileId] : [])))));
  }

  /** Свои файлы и файлы общих шаблонов портала (их отправляют все сотрудники). */
  private async visible(user: B24UserContext, ids: string[]) {
    const shared = await this.sharedFileIds(user.portal.id);
    return { id: { in: ids }, portalId: user.portal.id, OR: [{ ownerUserId: user.userId }, { id: { in: ids.filter((x) => shared.has(x)) } }] };
  }

  async sharedFileIds(portalId: string): Promise<Set<string>> {
    const rows = await this.prisma.messageTemplate.findMany({ where: { portalId, shared: true }, select: { steps: true } });
    return new Set([...(await this.groupFileIds(portalId)), ...rows.flatMap((t) => (t.steps as { fileIds?: string[] }[]).flatMap((s) => s.fileIds ?? []))]);
  }

  async meta(user: B24UserContext, ids: string[]): Promise<Map<string, StoredFileDto>> {
    if (!ids.length) return new Map();
    const rows = await this.prisma.storedFile.findMany({
      where: await this.visible(user, ids),
      select: { id: true, name: true, mime: true, size: true },
    });
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** Содержимое своих файлов и файлов общих шаблонов; чужой или несуществующий id — 404. */
  async loadOwned(user: B24UserContext, ids: string[]): Promise<Map<string, { name: string; data: Buffer }>> {
    if (!ids.length) return new Map();
    const rows = await this.prisma.storedFile.findMany({
      where: await this.visible(user, ids),
      select: { id: true, name: true, data: true },
    });
    if (rows.length !== ids.length)
      throw new NotFoundException({ code: 'FILE_NOT_FOUND', message: 'Вложение не найдено' });
    return new Map(rows.map((r) => [r.id, { name: r.name, data: Buffer.from(r.data) }]));
  }

  async assertOwned(user: B24UserContext, ids: string[]): Promise<void> {
    const found = await this.meta(user, ids);
    if (found.size !== new Set(ids).size)
      throw new NotFoundException({ code: 'FILE_NOT_FOUND', message: 'Вложение не найдено' });
  }

  /** Удалить свои файлы из `ids`, если они не входят ни в один шаблон автора и ни в один общий. */
  async dropUnused(user: B24UserContext, ids: string[]): Promise<void> {
    if (!ids.length) return;
    const used = new Set([...(await this.usedByTemplates(user)), ...(await this.sharedFileIds(user.portal.id))]);
    const drop = ids.filter((id) => !used.has(id));
    if (drop.length)
      await this.prisma.storedFile.deleteMany({
        where: { id: { in: drop }, portalId: user.portal.id, ownerUserId: user.userId },
      });
  }

  /** Разовые файлы старше суток, не попавшие в шаблоны (загрузили, но не отправили). */
  async dropStale(user: B24UserContext): Promise<void> {
    const old = await this.prisma.storedFile.findMany({
      where: {
        portalId: user.portal.id,
        ownerUserId: user.userId,
        createdAt: { lt: new Date(Date.now() - ORPHAN_TTL_MS) },
      },
      select: { id: true },
    });
    await this.dropUnused(
      user,
      old.map((f) => f.id),
    );
  }

  private async usedByTemplates(user: B24UserContext): Promise<Set<string>> {
    const templates = await this.prisma.messageTemplate.findMany({
      where: { portalId: user.portal.id, ownerUserId: user.userId },
      select: { steps: true },
    });
    return new Set(templates.flatMap((t) => (t.steps as { fileIds?: string[] }[]).flatMap((s) => s.fileIds ?? [])));
  }
}
