import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { ChatFolderDto } from '@btx24/shared';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { ChatsService } from './chats.service.js';

const nameSchema = z.object({ name: z.string().trim().min(1).max(60) }).strict();
const MAX_FOLDERS = 30;

/**
 * Личные папки чатов сотрудника: видит и меняет только владелец (портал + сотрудник). Чат — только
 * в одной папке сотрудника; удаление папки возвращает её чаты в общий список.
 */
@Injectable()
export class ChatFoldersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly chats: ChatsService,
  ) {}

  /** Папки со сводкой: сколько чатов, непрочитанные и последнее сообщение среди чатов папки. */
  async list(user: B24UserContext): Promise<ChatFolderDto[]> {
    const folders = await this.prisma.chatFolder.findMany({
      where: { portalId: user.portal.id, ownerUserId: user.userId },
      include: { items: true },
      orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }],
    });
    if (!folders.length) return [];
    const allIds = folders.flatMap((f) => f.items.map((i) => i.chatId));
    const [unread, summaries] = await Promise.all([
      this.chats.unreadByChat(user),
      allIds.length ? this.chats.summariesByChat(user, allIds) : Promise.resolve([]),
    ]);
    const byId = new Map(summaries.map((c) => [c.chatId, c]));
    return folders.map((f) => {
      const inside = f.items.map((i) => byId.get(i.chatId)).filter((c): c is NonNullable<typeof c> => !!c);
      const last = inside
        .filter((c) => c.lastMessage)
        .sort((a, b) => b.lastMessage!.date.localeCompare(a.lastMessage!.date))[0];
      return {
        id: f.id,
        name: f.name,
        sort: f.sort,
        chatCount: f.items.length,
        unread: f.items.reduce((n, i) => n + (unread.get(i.chatId) ?? 0), 0),
        last: last?.lastMessage
          ? {
              chatId: last.chatId,
              title: last.title,
              preview: last.lastMessage.preview,
              date: last.lastMessage.date,
              author: last.lastMessage.author,
            }
          : null,
      };
    });
  }

  async create(user: B24UserContext, body: unknown): Promise<{ id: string }> {
    const { name } = this.name(body);
    const count = await this.prisma.chatFolder.count({ where: { portalId: user.portal.id, ownerUserId: user.userId } });
    if (count >= MAX_FOLDERS) throw new BadRequestException({ code: 'TOO_MANY_FOLDERS', message: `Не больше ${MAX_FOLDERS} папок` });
    const f = await this.prisma.chatFolder.create({ data: { portalId: user.portal.id, ownerUserId: user.userId, name, sort: count } });
    return { id: f.id };
  }

  async rename(user: B24UserContext, id: string, body: unknown): Promise<void> {
    await this.own(user, id);
    await this.prisma.chatFolder.update({ where: { id }, data: this.name(body) });
  }

  /** Удалить папку: её чаты возвращаются в общий список (записи папки удаляются каскадом). */
  async remove(user: B24UserContext, id: string): Promise<void> {
    await this.own(user, id);
    await this.prisma.chatFolder.delete({ where: { id } });
  }

  /** Положить чат в папку (или перенести из другой моей папки). */
  async put(user: B24UserContext, id: string, chatId: number): Promise<void> {
    await this.own(user, id);
    const key = { portalId_ownerUserId_chatId: { portalId: user.portal.id, ownerUserId: user.userId, chatId } };
    await this.prisma.chatFolderItem.upsert({
      where: key,
      create: { folderId: id, portalId: user.portal.id, ownerUserId: user.userId, chatId },
      update: { folderId: id, addedAt: new Date() },
    });
  }

  /** Вернуть чат в общий список. */
  async takeOut(user: B24UserContext, chatId: number): Promise<void> {
    await this.prisma.chatFolderItem.deleteMany({ where: { portalId: user.portal.id, ownerUserId: user.userId, chatId } });
  }

  private name(body: unknown): { name: string } {
    const p = nameSchema.safeParse(body);
    if (!p.success) throw new BadRequestException({ code: 'INVALID_NAME', message: 'Название папки — от 1 до 60 символов' });
    return p.data;
  }

  private async own(user: B24UserContext, id: string): Promise<void> {
    const f = await this.prisma.chatFolder.findFirst({ where: { id, portalId: user.portal.id, ownerUserId: user.userId } });
    if (!f) throw new NotFoundException({ code: 'FOLDER_NOT_FOUND', message: 'Папка не найдена' });
  }
}
