import { Injectable, Logger, Optional } from '@nestjs/common';
import type { Messenger, MessengerMessage, Prisma } from '../../generated/prisma/client.js';
import { MessengerCrmService } from './messenger-crm.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { WireEvent, WireMessage, WireReaction } from './messenger-service.client.js';

/** Номер собеседника из ID личного чата (`79991234567@c.us`); скрытые номера (`…@lid`) и группы — null. */
export const phoneOfChat = (chatId: string): string | null => (/^(\d{10,15})@c\.us$/.exec(chatId)?.[1] ?? null);
/** Текст для списка чатов: вложение без подписи — его тип. */
export const previewOf = (m: { body: string; type: string; hasMedia: boolean }) =>
  (m.body.trim() || (m.hasMedia ? `[${MEDIA_LABELS[m.type] ?? 'вложение'}]` : '')).slice(0, 500);
const MEDIA_LABELS: Record<string, string> = { image: 'фото', video: 'видео', ptt: 'голосовое', audio: 'аудио', document: 'файл', sticker: 'стикер', location: 'геопозиция' };

/** Правки и удаления передаются в линию: входящие и переданные туда сообщения с телефона. */
const relayedFromChat = (row: MessengerMessage) => !row.fromMe || (row.source === 'messenger' && !!row.relayedAt);

/** Колонки вложения: скачанное — с файлом, нескачанное — только описание из WhatsApp. */
export function mediaColumns(w: WireMessage) {
  const info = w.media ?? (w.mediaInfo ? { fileId: null, mime: w.mediaInfo.mime, name: w.mediaInfo.name, size: w.mediaInfo.size } : null);
  if (!info) return {};
  return { mediaId: info.fileId, mediaMime: info.mime?.slice(0, 150) ?? null, mediaName: info.name?.slice(0, 255) ?? null, mediaSize: info.size };
}

/** Куда ещё отдать изменения переписки (своя открытая линия — `MessengerConnectorService`). */
export interface InboxListener {
  incoming(messenger: Messenger, msg: MessengerMessage, name: string | null): Promise<void>;
  /** Отправлено с телефона (не из приложения и не из линии). */
  outgoing(messenger: Messenger, msg: MessengerMessage): Promise<void>;
  edited(messenger: Messenger, msg: MessengerMessage): Promise<void>;
  revoked(messenger: Messenger, msg: MessengerMessage): Promise<void>;
}

/**
 * Переписка мессенджеров в базе приложения (ADR 0014): одна копия на портал, общая для сотрудников.
 * События сервиса применяются идемпотентно (по ID сообщения): повтор и любой порядок безопасны.
 * Правка сохраняет прежний текст (`edits`), удаление — отметка `deletedAt`, текст остаётся в базе.
 */
@Injectable()
export class MessengerInboxService {
  private readonly logger = new Logger(MessengerInboxService.name);
  private listener: InboxListener | null = null;

  constructor(private readonly prisma: PrismaService, @Optional() private readonly crm?: MessengerCrmService) {}

  listen(l: InboxListener): void {
    this.listener = l;
  }

  async apply(events: WireEvent[]): Promise<void> {
    const cache = new Map<string, Messenger | null>();
    const messengerOf = async (id: string) => {
      if (!cache.has(id)) cache.set(id, await this.prisma.messenger.findUnique({ where: { id } }));
      return cache.get(id) ?? null;
    };
    for (const e of events) {
      const m = await messengerOf(e.instanceId);
      if (!m) continue; // Мессенджер удалён — событие не нужно.
      try {
        if (e.type === 'message') await this.message(m, e.message);
        else if (e.type === 'edit') await this.edit(m, e.id, e.body, e.prevBody, e.at);
        else if (e.type === 'revoke') await this.revoke(m, e.id, e.at);
        else if (e.type === 'reaction') await this.react(m, e.id, e.reactions);
        else await this.prisma.messengerMessage.updateMany({ where: { messengerId: m.id, externalId: e.id, OR: [{ ack: null }, { ack: { lt: e.ack } }] }, data: { ack: e.ack } });
      } catch (err) {
        this.logger.warn(`messenger ${m.id} ${e.type}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Сообщение (входящее или отправленное) — в базу; вернуть строку. `extra` — откуда отправлено
   * приложением; `relay: false` — не передавать в открытую линию (загрузка истории).
   */
  async message(m: Messenger, w: WireMessage, extra: Partial<Prisma.MessengerMessageUncheckedCreateInput> = {}, opts: { relay?: boolean } = {}): Promise<MessengerMessage> {
    const prev = await this.prisma.messengerMessage.findUnique({ where: { messengerId_externalId: { messengerId: m.id, externalId: w.id } } });
    const sentAt = new Date(w.timestamp * 1000);
    const routing = !prev && this.crm && opts.relay !== false ? await this.crm.route(m, w.chatId, w.phone) : {};

    const row = await this.prisma.messengerMessage.upsert({
      where: { messengerId_externalId: { messengerId: m.id, externalId: w.id } },
      create: {
        portalId: m.portalId,
        messengerId: m.id,
        chatId: w.chatId,
        externalId: w.id,
        fromMe: w.fromMe,
        author: w.author,
        authorName: w.authorName?.slice(0, 255) ?? null,
        body: w.body,
        type: w.type,
        hasMedia: w.hasMedia,
        ...mediaColumns(w),
        quotedId: w.quotedId,
        sentAt,
        ack: w.ack,
        ...routing,
        ...extra,
      },
      // Повтор события или эхо своего же отправленного: не затираем источник и автора.
      update: { ...(w.ack !== null ? { ack: w.ack } : {}), ...(w.media ? mediaColumns(w) : {}), ...extra },
    });
    if (!prev) {
      const chat = await this.prisma.messengerChat.findUnique({ where: { messengerId_chatId: { messengerId: m.id, chatId: w.chatId } } });
      const newest = !chat?.lastMessageAt || chat.lastMessageAt <= sentAt;
      await this.prisma.messengerChat.upsert({
        where: { messengerId_chatId: { messengerId: m.id, chatId: w.chatId } },
        create: { portalId: m.portalId, messengerId: m.id, chatId: w.chatId, phone: w.phone ?? phoneOfChat(w.chatId), name: w.name, lastMessageAt: sentAt, lastText: previewOf(w), unread: w.fromMe ? 0 : 1 },
        update: {
          ...(w.name ? { name: w.name.slice(0, 255) } : {}),
          ...(w.phone ? { phone: w.phone } : {}),
          ...(newest ? { lastMessageAt: sentAt, lastText: previewOf(w) } : {}),
          ...(newest ? (w.fromMe ? { unread: 0 } : { unread: { increment: 1 } }) : {}),
        },
      });
      // В свою открытую линию: новое входящее и отправленное с телефона (отправленное из линии и
      // приложения уже там — у него `extra.source`).
      if (opts.relay !== false && !extra.source && this.listener) {
        if (!w.fromMe) await this.listener.incoming(m, row, w.name).catch((err: unknown) => this.relayFailed(row, err));
        else await this.listener.outgoing(m, row).catch((err: unknown) => this.relayFailed(row, err));
      }
    }
    return row;
  }

  async edit(m: Messenger, externalId: string, body: string, prevBody: string, at: number): Promise<MessengerMessage | null> {
    const row = await this.prisma.messengerMessage.findUnique({ where: { messengerId_externalId: { messengerId: m.id, externalId } } });
    if (!row || row.body === body) return row;
    const edits = [...((row.edits as { at: string; body: string }[] | null) ?? []), { at: new Date(at * 1000).toISOString(), body: prevBody || row.body }];
    const updated = await this.prisma.messengerMessage.update({ where: { id: row.id }, data: { body, editedAt: new Date(at * 1000), edits } });
    if (relayedFromChat(row) && this.listener) await this.listener.edited(m, updated).catch((err: unknown) => this.relayFailed(updated, err));
    return updated;
  }

  async revoke(m: Messenger, externalId: string, at: number): Promise<MessengerMessage | null> {
    const row = await this.prisma.messengerMessage.findUnique({ where: { messengerId_externalId: { messengerId: m.id, externalId } } });
    if (!row || row.deletedAt) return row;
    const updated = await this.prisma.messengerMessage.update({ where: { id: row.id }, data: { deletedAt: new Date(at * 1000) } });
    if (relayedFromChat(row) && this.listener) await this.listener.revoked(m, updated).catch((err: unknown) => this.relayFailed(updated, err));
    return updated;
  }

  /** Реакции сообщения — текущий набор из мессенджера (повтор безопасен). */
  async react(m: Messenger, externalId: string, reactions: WireReaction[]): Promise<void> {
    const clean = (reactions ?? []).filter((r) => typeof r?.emoji === 'string' && r.emoji.length <= 16).slice(0, 100).map((r) => ({ emoji: r.emoji, mine: !!r.mine }));
    await this.prisma.messengerMessage.updateMany({ where: { messengerId: m.id, externalId }, data: { reactions: clean } });
  }

  private async relayFailed(row: MessengerMessage, err: unknown) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    this.logger.warn(`relay ${row.externalId}: ${message}`);
    await this.prisma.messengerMessage.update({ where: { id: row.id }, data: { relayError: message } });
  }
}
