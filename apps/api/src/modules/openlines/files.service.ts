import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { StoredFileDto } from '@btx24/shared';
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

  /** Свои файлы и файлы общих шаблонов портала (их отправляют все сотрудники). */
  private async visible(user: B24UserContext, ids: string[]) {
    const shared = await this.sharedFileIds(user.portal.id);
    return { id: { in: ids }, portalId: user.portal.id, OR: [{ ownerUserId: user.userId }, { id: { in: ids.filter((x) => shared.has(x)) } }] };
  }

  async sharedFileIds(portalId: string): Promise<Set<string>> {
    const rows = await this.prisma.messageTemplate.findMany({ where: { portalId, shared: true }, select: { steps: true } });
    return new Set(rows.flatMap((t) => (t.steps as { fileIds?: string[] }[]).flatMap((s) => s.fileIds ?? [])));
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
