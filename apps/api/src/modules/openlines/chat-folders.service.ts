import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { FAVORITES_FOLDER, type ChatFolderDto } from '@btx24/shared';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { ChatsService } from './chats.service.js';

const nameSchema = z.object({ name: z.string().trim().min(1).max(60) }).strict();
/** Правка папки: название, «Не обращать внимания», глобальная. */
const updateSchema = z
  .object({ name: z.string().trim().min(1).max(60).optional(), ignoreAttention: z.boolean().optional(), global: z.boolean().optional() })
  .strict()
  .refine((b) => b.name !== undefined || b.ignoreAttention !== undefined || b.global !== undefined, { message: 'Нечего менять' });
const MAX_FOLDERS = 30;

/**
 * Папки чатов: личные (видит и меняет владелец) и **глобальные** (решение владельца 2026-10-23) —
 * их видят все сотрудники, у которых есть доступ хотя бы к одному чату папки, и только эти чаты;
 * «Не обращать внимания» глобальной папки действует у всех; менять её может только владелец. Чат —
 * в одной папке сотрудника; своя папка важнее чужой глобальной. «★ Избранное» — псевдопапка.
 */
@Injectable()
export class ChatFoldersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly chats: ChatsService,
  ) {}

  /** Папки со сводкой: сколько чатов, непрочитанные и последнее сообщение среди чатов папки. */
  async list(user: B24UserContext): Promise<ChatFolderDto[]> {
    const portalId = user.portal.id;
    const [own, others, favorites, placement] = await Promise.all([
      this.prisma.chatFolder.findMany({ where: { portalId, ownerUserId: user.userId }, include: { items: true }, orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }] }),
      this.prisma.chatFolder.findMany({ where: { portalId, global: true, ownerUserId: { not: user.userId } }, include: { items: true }, orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }] }),
      this.chats.favorites(user),
      this.chats.myFolders(user),
    ]);
    // Чужие глобальные: только чаты, где папка — действующая для меня и чат мне доступен (кэш доступа).
    const allowed = others.length
      ? new Set(
          (
            await this.prisma.openlineChatAccess.findMany({
              where: { portalId, userId: user.userId, allowed: true, chatId: { in: others.flatMap((f) => f.items.map((i) => i.chatId)) } },
              select: { chatId: true },
            })
          ).map((a) => a.chatId),
        )
      : new Set<number>();
    const folders = [
      ...own.map((f) => ({ f, chatIds: f.items.map((i) => i.chatId), mine: true })),
      ...others
        .map((f) => ({ f, chatIds: f.items.map((i) => i.chatId).filter((id) => allowed.has(id) && placement.get(id) === f.id), mine: false }))
        .filter((x) => x.chatIds.length),
    ];
    if (!folders.length && !favorites.size) return [];
    const allIds = [...new Set([...folders.flatMap((x) => x.chatIds), ...favorites])];
    const summaries = allIds.length ? await this.chats.summariesByChat(user, allIds) : [];
    const byId = new Map(summaries.map((c) => [c.chatId, c]));
    const sum = (id: string, name: string, chatIds: number[], extra: Pick<ChatFolderDto, 'sort' | 'ignoreAttention' | 'global' | 'mine' | 'kind'>): ChatFolderDto => {
      const inside = chatIds.map((i) => byId.get(i)).filter((c): c is NonNullable<typeof c> => !!c);
      const last = inside.filter((c) => c.lastMessage).sort((a, b) => b.lastMessage!.date.localeCompare(a.lastMessage!.date))[0];
      return {
        id,
        name,
        ...extra,
        chatCount: extra.mine && extra.kind !== 'favorites' ? chatIds.length : inside.length,
        // Сумма счётчиков чатов папки («Не требует ответа» уже обнулил свои).
        unread: inside.reduce((n, c) => n + c.unread, 0),
        last: last?.lastMessage
          ? { chatId: last.chatId, title: last.title, preview: last.lastMessage.preview, date: last.lastMessage.date, author: last.lastMessage.author }
          : null,
      };
    };
    return [
      ...(favorites.size ? [sum(FAVORITES_FOLDER, 'Избранное', [...favorites], { sort: -1, ignoreAttention: false, global: false, mine: true, kind: 'favorites' })] : []),
      ...folders.map(({ f, chatIds, mine }) => sum(f.id, f.name, chatIds, { sort: f.sort, ignoreAttention: f.ignoreAttention, global: f.global, mine, kind: 'folder' })),
    ];
  }

  /** ★ Избранное: добавить или убрать чат (личное). */
  async favorite(user: B24UserContext, chatId: number, on: boolean): Promise<void> {
    const key = { portalId_userId_chatId: { portalId: user.portal.id, userId: user.userId, chatId } };
    if (on) await this.prisma.chatFavorite.upsert({ where: key, create: { portalId: user.portal.id, userId: user.userId, chatId }, update: {} });
    else await this.prisma.chatFavorite.deleteMany({ where: { portalId: user.portal.id, userId: user.userId, chatId } });
  }

  async create(user: B24UserContext, body: unknown): Promise<{ id: string }> {
    const { name } = this.name(body);
    const count = await this.prisma.chatFolder.count({ where: { portalId: user.portal.id, ownerUserId: user.userId } });
    if (count >= MAX_FOLDERS) throw new BadRequestException({ code: 'TOO_MANY_FOLDERS', message: `Не больше ${MAX_FOLDERS} папок` });
    const f = await this.prisma.chatFolder.create({ data: { portalId: user.portal.id, ownerUserId: user.userId, name, sort: count } });
    return { id: f.id };
  }

  /** Переименовать папку, отметить «Не обращать внимания» или сделать глобальной (только владелец). */
  async rename(user: B24UserContext, id: string, body: unknown): Promise<{ name?: string; ignoreAttention?: boolean; global?: boolean }> {
    await this.own(user, id);
    const p = updateSchema.safeParse(body);
    if (!p.success) throw new BadRequestException({ code: 'INVALID_FOLDER', message: 'Название папки — от 1 до 60 символов' });
    await this.prisma.chatFolder.update({ where: { id }, data: p.data });
    return p.data;
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
