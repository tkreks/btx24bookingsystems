import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { MESSENGER_MAX_FILE_BYTES, normalizeMessengerPhone, type MessengerContactSearchDto, type MessengerChatDto, type MessengerLinkDto, type MessengerMessageDto, type MessengerSendResultDto } from '@btx24/shared';
import type { Messenger, MessengerMessage } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AccessService } from '../access/access.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { Bitrix24Error } from '../bitrix24/rest/errors.js';
import { MessengerConnectorService } from './messenger-connector.service.js';
import { MessengerCrmService } from './messenger-crm.service.js';
import { MessengerInboxService } from './messenger-inbox.service.js';
import { MessengerServiceClient } from './messenger-service.client.js';
import { toDto } from './messengers.service.js';

const PAGE = 50;
export const groupIdsOf = (m: Messenger): string[] => (Array.isArray(m.groupIds) ? (m.groupIds as unknown[]).filter((x): x is string => typeof x === 'string') : []);

/**
 * Переписка мессенджеров (ADR 0014, решение владельца 2026-10-24):
 * - **номер привязан к своей открытой линии** — сотрудник пишет через линию Битрикс24 (`im.message.add`
 *   его токеном: действие видно в Битрикс24), линия присылает событие коннектору, приложение доставляет
 *   в мессенджер (очередь). Права на чаты — права линии; в обход линии читают только администраторы.
 * - **не привязан** — номер работает только в приложении, напрямую через шлюз, для групп номера.
 */
@Injectable()
export class MessengerChatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly service: MessengerServiceClient,
    private readonly inbox: MessengerInboxService,
    private readonly connector: MessengerConnectorService,
    private readonly access: AccessService,
    @Optional() private readonly crm?: MessengerCrmService,
  ) {}

  async own(portalId: string, id: string): Promise<Messenger> {
    const m = await this.prisma.messenger.findFirst({ where: { id, portalId } });
    if (!m) throw new NotFoundException({ code: 'MESSENGER_NOT_FOUND', message: 'Мессенджер не найден' });
    return m;
  }

  // ---------- доступ сотрудника ----------

  /** Номера, доступные сотруднику в приложении: группы номера ∩ его группы с `openlines.read`. */
  async available(user: B24UserContext): Promise<Messenger[]> {
    const a = await this.access.resolve(user);
    const rows = await this.prisma.messenger.findMany({ where: { portalId: user.portal.id }, orderBy: { createdAt: 'asc' } });
    if (a.isAppAdmin) return rows;
    const mine = new Set(a.groups.filter((g) => g.permissions.includes('openlines.read')).map((g) => g.group.id));
    return rows.filter((m) => groupIdsOf(m).some((g) => mine.has(g)));
  }

  /** Номера из `rows`, с которых сотрудник может писать (группа номера с `openlines.send`). */
  async sendable(user: B24UserContext, rows: Messenger[]): Promise<Set<string>> {
    const a = await this.access.resolve(user);
    if (a.isAppAdmin) return new Set(rows.map((m) => m.id));
    const mine = new Set(a.groups.filter((g) => g.permissions.includes('openlines.send')).map((g) => g.group.id));
    return new Set(rows.filter((m) => groupIdsOf(m).some((g) => mine.has(g))).map((m) => m.id));
  }

  /**
   * Номер для работы сотрудника: доступен по группе; привязан к линии — только администратору (права на
   * чаты линии решает Битрикс24, сотрудники работают в «Чатах»); `send` — нужно `openlines.send` в группе.
   */
  async forUser(user: B24UserContext, id: string, send: boolean, remoteChatId?: string): Promise<{ m: Messenger; admin: boolean }> {
    const a = await this.access.resolve(user);
    const m = await this.own(user.portal.id, id);
    if (a.isAppAdmin) return { m, admin: true };
    const groups = new Set(groupIdsOf(m));
    const perm = send ? 'openlines.send' : 'openlines.read';
    if (!a.groups.some((g) => groups.has(g.group.id) && g.permissions.includes(perm)))
      throw new ForbiddenException({ code: 'NO_MESSENGER_ACCESS', message: send ? 'Нет права писать с этого номера' : 'Нет доступа к этому номеру' });
    if (m.lineMode === 'own' && remoteChatId) {
      const phone = normalizeMessengerPhone(remoteChatId.includes('@') ? remoteChatId.split('@')[0] : remoteChatId);
      const known = phone ? await this.prisma.messengerChat.findFirst({ where: { portalId: m.portalId, messengerId: m.id, phone } }) : null;
      const chatId = known?.chatId ?? remoteChatId;
      const links = await this.prisma.messengerMessage.findMany({ where: { portalId: m.portalId, messengerId: m.id, chatId, b24ChatId: { not: null } }, distinct: ['b24ChatId'], select: { b24ChatId: true } });
      for (const link of links) {
        const dialog = (await user.client.call<{ id?: number }>('imopenlines.dialog.get', { CHAT_ID: link.b24ChatId })).result;
        if (!dialog?.id) throw new ForbiddenException('Нет доступа к диалогу открытой линии');
      }
    }
    return { m, admin: false };
  }

  /** Явный выбор сотрудника в канале: передать ожидающие входящие в собственную ОЛ, без исходящих клиенту. */
  async publishChosen(m: Messenger, chatId: string): Promise<void> {
    if (m.lineMode !== 'own' || !m.lineId) return;
    let cursor: string | undefined;
    for (;;) {
      const pending = await this.prisma.messengerMessage.findMany({ where: { portalId: m.portalId, messengerId: m.id, chatId, fromMe: false, awaitingDeal: false, relayedAt: null, deletedAt: null, ...(cursor ? { id: { gt: cursor } } : {}) }, orderBy: { id: 'asc' }, take: 100 });
      if (!pending.length) break;
      for (const row of pending) await this.connector.publishChosen(m, row);
      cursor = pending[pending.length - 1].id;
    }
  }

  async chatsForUser(user: B24UserContext, id: string) {
    const { m, admin } = await this.forUser(user, id, false);
    const rows = await this.chats(m);
    if (admin || m.lineMode !== 'own') return rows;
    const allowed = await Promise.all(rows.map(async row => {
      try { await this.forUser(user, id, false, row.chatId); return row; } catch { return null; }
    }));
    return allowed.filter((row): row is MessengerChatDto => row !== null);
  }

  async forMessage(user: B24UserContext, id: string, messageId: string, send: boolean) {
    const m = await this.own(user.portal.id, id);
    const row = await this.message(m, messageId);
    return this.forUser(user, id, send, row.chatId);
  }

  async forGroupSend(user: B24UserContext, id: string) {
    const a = await this.access.resolve(user); const m = await this.own(user.portal.id, id);
    if (!a.isAppAdmin && !a.groups.some(g => groupIdsOf(m).includes(g.group.id) && g.permissions.includes('openlines.send'))) throw new ForbiddenException('Нет права выбирать сделку для этого номера');
    return { m };
  }

  async setGroups(portalId: string, id: string, groupIds: unknown): Promise<Messenger> {
    await this.own(portalId, id);
    const ids = Array.isArray(groupIds) ? [...new Set(groupIds.filter((x): x is string => typeof x === 'string'))] : [];
    const known = new Set((await this.prisma.workGroup.findMany({ where: { portalId, id: { in: ids } }, select: { id: true } })).map((g) => g.id));
    return this.prisma.messenger.update({ where: { id }, data: { groupIds: ids.filter((g) => known.has(g)) } });
  }

  /** Поиск только по разрешённым номерам; проверка регистрации ничего не отправляет. */
  async search(user: B24UserContext, input: unknown): Promise<MessengerContactSearchDto> {
    const phone = normalizeMessengerPhone(input);
    if (!phone) throw new BadRequestException({ code: 'INVALID_PHONE', message: 'Укажите номер с кодом страны' });
    const [rows, access] = await Promise.all([this.available(user), this.access.resolve(user)]);
    const results = await Promise.all(rows.map(async m => {
      const messenger = toDto(m, null);
      const permitted = access.isAppAdmin || access.groups.some(g => groupIdsOf(m).includes(g.group.id) && g.permissions.includes('openlines.send'));
      try {
        const found = await this.service.contact(m.id, phone);
        if (!found.exists) return { messenger, status: 'not_found' as const, chatId: null, canSend: false, note: null, openlineChatId: null };
        const known = await this.prisma.messengerChat.findFirst({ where: { portalId: user.portal.id, messengerId: m.id, phone }, orderBy: { lastMessageAt: 'desc' } });
        const chatId = known?.chatId ?? found.chatId;
        const lineChat = chatId && m.lineMode === 'own' ? await this.lineChatOf(m, chatId) : null;
        let openlineChatId: number | null = null;
        if (lineChat) {
          try { const d = await user.client.call<{ id?: number }>('imopenlines.dialog.get', { CHAT_ID: lineChat }); if (d.result?.id) openlineChatId = lineChat; } catch { /* Права линии проверяет портал. */ }
        }
        const canSend = permitted && (m.lineMode !== 'own' || !lineChat || access.isAppAdmin || !!openlineChatId);
        return { messenger, status: 'found' as const, chatId, canSend, note: canSend ? null : m.lineMode === 'own' ? 'Нет доступа к диалогу открытой линии' : 'Нет права отправлять сообщения', openlineChatId };
      } catch {
        return { messenger, status: 'unavailable' as const, chatId: null, canSend: false, note: 'Не удалось проверить: проверьте подключение номера', openlineChatId: null };
      }
    }));
    const existingChats: NonNullable<MessengerContactSearchDto['existingChats']> = [];
    if (this.crm) {
      try {
        const matched = await this.crm.match(user.client, phone, true);
        const ids = new Set<number>();
        for (const entity of [...matched.contacts.map(c => ({ type: 'contact', id: c.id })), ...matched.deals.map(d => ({ type: 'deal', id: d.id }))]) {
          const found = await user.client.call<{ CHAT_ID: string; CONNECTOR_ID?: string }[]>('imopenlines.crm.chat.get', { CRM_ENTITY_TYPE: entity.type, CRM_ENTITY: entity.id, ACTIVE_ONLY: 'N' });
          for (const c of found.result ?? []) {
            const chatId = Number(c.CHAT_ID); if (!chatId || ids.has(chatId)) continue;
            try {
              const dialog = (await user.client.call<{ id?: number; name?: string }>('imopenlines.dialog.get', { CHAT_ID: chatId })).result;
              if (dialog?.id) { ids.add(chatId); existingChats.push({ chatId, title: dialog.name ?? `Чат #${chatId}`, connector: c.CONNECTOR_ID ?? '' }); }
            } catch { /* Отдельный диалог может быть закрыт правами линии. */ }
          }
        }
      } catch { /* Поиск мессенджеров остаётся доступен при отсутствии доступа к CRM. */ }
    }
    return { phone, results, existingChats };
  }

  async fromOpenline(user: B24UserContext, b24ChatId: number) {
    const row = await this.prisma.messengerMessage.findFirst({ where: { portalId: user.portal.id, b24ChatId }, orderBy: { sentAt: 'desc' } });
    if (!row) throw new NotFoundException('Диалог другого провайдера');
    const m = (await this.available(user)).find(m => m.id === row.messengerId);
    if (!m) throw new ForbiddenException('Нет доступа к номеру');
    const dialog = (await user.client.call<{ id?: number }>('imopenlines.dialog.get', { CHAT_ID: b24ChatId })).result;
    if (!dialog?.id) throw new ForbiddenException('Нет доступа к диалогу');
    return { m, chatId: row.chatId };
  }

  // ---------- переписка ----------

  async chats(m: Messenger): Promise<MessengerChatDto[]> {
    const rows = await this.prisma.messengerChat.findMany({ where: { messengerId: m.id }, orderBy: { lastMessageAt: 'desc' }, take: 200 });
    return rows.map((c) => ({ chatId: c.chatId, phone: c.phone, name: c.name, lastMessageAt: c.lastMessageAt?.toISOString() ?? null, lastText: c.lastText, unread: c.unread }));
  }

  /** Сообщения чата, новые снизу; `before` — ISO-время, страница раньше него. */
  async messages(m: Messenger, chatId: string, before?: string, dealId?: number | null): Promise<MessengerMessageDto[]> {
    const rows = await this.prisma.messengerMessage.findMany({
      where: { portalId: m.portalId, messengerId: m.id, chatId, ...(dealId !== undefined ? { dealId } : {}), ...(before && Number.isFinite(Date.parse(before)) ? { sentAt: { lt: new Date(before) } } : {}) },
      orderBy: { sentAt: 'desc' },
      take: PAGE,
    });
    await this.prisma.messengerChat.updateMany({ where: { messengerId: m.id, chatId }, data: { unread: 0 } });
    return rows.reverse().map(toMessageDto);
  }

  /**
   * Написать клиенту. Привязан к линии — через линию (действие сотрудника в Битрикс24); первый контакт
   * (чата в линии ещё нет) — открываем чат в линии сообщением от имени сотрудника и доставляем сами.
   * Не привязан — напрямую через шлюз.
   */
  async send(user: B24UserContext, m: Messenger, to: string, text: string, expectedDeal?: number | null): Promise<MessengerSendResultDto> {
    const body = String(text ?? '').trim().slice(0, 4096);
    if (!body) throw new BadRequestException({ code: 'EMPTY_MESSAGE', message: 'Пустое сообщение' });
    const target = String(to ?? '').includes('@') ? String(to) : normalizeMessengerPhone(to) && `${normalizeMessengerPhone(to)}@c.us`;
    if (!target) throw new BadRequestException({ code: 'INVALID_PHONE', message: 'Номер телефона: 10–15 цифр с кодом страны' });
    // Тот же собеседник может быть известен по номеру (`…@c.us`) и по скрытому ID (`…@lid`): чат —
    // уже известный (по номеру), отправка — по номеру (по скрытому ID WhatsApp Web отправляет не всегда).
    const known = target.endsWith('@c.us')
      ? await this.prisma.messengerChat.findFirst({ where: { messengerId: m.id, phone: target.replace(/@.*$/, '') }, orderBy: { lastMessageAt: 'desc' } })
      : await this.prisma.messengerChat.findUnique({ where: { messengerId_chatId: { messengerId: m.id, chatId: target } } });
    const sendTo = known?.phone ? `${known.phone}@c.us` : target;
    const dealId = this.crm ? await this.crm.sending(user, m, known?.chatId ?? target, expectedDeal) : undefined;
    if (m.lineMode !== 'own' || !m.lineId) {
      const w = await this.service.send(m.id, sendTo, body);
      return { message: toMessageDto(await this.inbox.message(m, w, { source: 'app', sentByUserId: user.userId, ...(dealId !== undefined ? { dealId, awaitingDeal: false } : {}) })), queued: false };
    }
    const b24ChatId = await this.lineChatOf(m, known?.chatId ?? target, dealId);
    if (b24ChatId) {
      await this.postToLine(user, b24ChatId, body);
      return { message: null, queued: true };
    }
    return { message: toMessageDto(await this.connector.firstContact(user, m, sendTo, body, undefined, dealId)), queued: false };
  }

  /** Вложение сообщения: из хранилища сервиса (история — скачивается сейчас и запоминается). */
  async media(m: Messenger, messageId: string): Promise<{ data: Buffer; mime: string; name: string }> {
    let row = await this.message(m, messageId);
    if (row.deletedAt) throw new NotFoundException({ code: 'MEDIA_DELETED', message: 'Сообщение удалено' });
    if (!row.hasMedia) throw new NotFoundException({ code: 'NO_MEDIA', message: 'У сообщения нет вложения' });
    if (!row.mediaId) {
      const meta = await this.service.mediaOf(m.id, row.externalId);
      row = await this.prisma.messengerMessage.update({ where: { id: row.id }, data: { mediaId: meta.fileId, mediaMime: meta.mime.slice(0, 150), mediaName: meta.name?.slice(0, 255) ?? row.mediaName, mediaSize: meta.size } });
    }
    const file = await this.service.readMedia(m.id, row.mediaId!);
    if (!file) throw new NotFoundException({ code: 'NO_MEDIA', message: 'Файл вложения недоступен' });
    return { ...file, name: row.mediaName ?? 'file' };
  }

  /**
   * Отправить файл (фото, видео, аудио, документ) с подписью. Привязан к линии — файл уходит клиенту и
   * дублируется в чат линии от имени сотрудника (как первое сообщение); не привязан — напрямую.
   */
  async sendFile(user: B24UserContext, m: Messenger, to: string, text: string, file: { mime: string; name: string; data: Buffer }, expectedDeal?: number | null): Promise<MessengerSendResultDto> {
    if (!file.data.length || file.data.length > MESSENGER_MAX_FILE_BYTES) throw new BadRequestException({ code: 'INVALID_FILE_SIZE', message: 'Размер файла: от 1 байта до 64 МБ' });
    const target = String(to ?? '').includes('@') ? String(to) : normalizeMessengerPhone(to) && `${normalizeMessengerPhone(to)}@c.us`;
    if (!target) throw new BadRequestException({ code: 'INVALID_PHONE', message: 'Номер телефона: 10–15 цифр с кодом страны' });
    const known = target.endsWith('@c.us')
      ? await this.prisma.messengerChat.findFirst({ where: { messengerId: m.id, phone: target.replace(/@.*$/, '') }, orderBy: { lastMessageAt: 'desc' } })
      : await this.prisma.messengerChat.findUnique({ where: { messengerId_chatId: { messengerId: m.id, chatId: target } } });
    const sendTo = known?.phone ? `${known.phone}@c.us` : target;
    const dealId = this.crm ? await this.crm.sending(user, m, known?.chatId ?? target, expectedDeal) : undefined;
    const caption = String(text ?? '').trim().slice(0, 1024);
    if (m.lineMode === 'own' && m.lineId) return { message: toMessageDto(await this.connector.firstContact(user, m, sendTo, caption, file, dealId)), queued: false };
    const w = await this.service.send(m.id, sendTo, caption, undefined, file);
    return { message: toMessageDto(await this.inbox.message(m, w, { source: 'app', sentByUserId: user.userId, ...(dealId !== undefined ? { dealId, awaitingDeal: false } : {}) })), queued: false };
  }

  /** Изменить своё сообщение: через линию (если оно из линии) или напрямую. Прежний текст — в истории. */
  async edit(user: B24UserContext, m: Messenger, messageId: string, text: string): Promise<MessengerMessageDto> {
    const row = await this.message(m, messageId);
    if (!row.fromMe) throw new BadRequestException({ code: 'NOT_OWN', message: 'Изменить можно только своё сообщение' });
    const body = String(text ?? '').trim();
    if (!body) throw new BadRequestException({ code: 'EMPTY_MESSAGE', message: 'Пустое сообщение' });
    if (m.lineMode === 'own' && row.b24MessageId) {
      // Через линию: Битрикс24 пришлёт OnImConnectorMessageUpdate — правку в мессенджере выполнит коннектор.
      await user.client.call('im.message.update', { MESSAGE_ID: row.b24MessageId, MESSAGE: body });
      return toMessageDto(row);
    }
    const w = await this.service.edit(m.id, row.externalId, body);
    return toMessageDto((await this.inbox.edit(m, row.externalId, w.body, row.body, Math.floor(Date.now() / 1000))) ?? row);
  }

  /** Удалить у всех своё сообщение: через линию или напрямую. В базе остаётся с отметкой «удалено». */
  async remove(user: B24UserContext, m: Messenger, messageId: string): Promise<MessengerMessageDto> {
    const row = await this.message(m, messageId);
    if (!row.fromMe) throw new BadRequestException({ code: 'NOT_OWN', message: 'Удалить у всех можно только своё сообщение' });
    if (m.lineMode === 'own' && row.b24MessageId) {
      await user.client.call('im.message.delete', { MESSAGE_ID: row.b24MessageId });
      return toMessageDto(row);
    }
    await this.service.deleteMessage(m.id, row.externalId, true);
    return toMessageDto((await this.inbox.revoke(m, row.externalId, Math.floor(Date.now() / 1000))) ?? row);
  }

  /** Загрузить историю из мессенджера (последние чаты и сообщения) — в открытую линию не передаётся. */
  async importHistory(m: Messenger): Promise<{ messages: number }> {
    const list = await this.service.history(m.id, 50, 50);
    for (const w of list.sort((a, b) => a.timestamp - b.timestamp)) await this.inbox.message(m, w, {}, { relay: false });
    return { messages: list.length };
  }

  // ---------- своя открытая линия ----------

  /** Создать свою линию и привязать номер, или отвязать (`mode: null`). */
  async link(user: B24UserContext, id: string, body: MessengerLinkDto): Promise<Messenger> {
    const m = await this.own(user.portal.id, id);
    if (body?.mode === null) {
      await this.connector.detach(user.portal, m);
      return this.prisma.messenger.update({ where: { id }, data: { lineMode: null, lineId: null, lineName: null } });
    }
    if (body?.mode === 'own') {
      if (m.lineMode === 'own') throw new BadRequestException({ code: 'ALREADY_LINKED', message: `Номер уже привязан к линии «${m.lineName ?? m.lineId}»` });
      const name = String(body.name ?? '').trim().slice(0, 255) || `${m.kind === 'telegram' ? 'Telegram' : 'WhatsApp'} +${m.phone}`;
      const line = await this.connector.createOwnLine(user.portal, m, name);
      return this.prisma.messenger.update({ where: { id }, data: { lineMode: 'own', lineId: line.lineId, lineName: line.name } });
    }
    throw new BadRequestException({ code: 'INVALID_LINK', message: 'mode: own или null' });
  }

  /** Чат линии для клиента — из уже переданных в линию сообщений. */
  private async lineChatOf(m: Messenger, chatId: string, dealId?: number | null): Promise<number | null> {
    const row = await this.prisma.messengerMessage.findFirst({ where: { portalId: m.portalId, messengerId: m.id, chatId, ...(dealId !== undefined ? { dealId } : {}), b24ChatId: { not: null } }, orderBy: { sentAt: 'desc' }, select: { b24ChatId: true } });
    return row?.b24ChatId ?? null;
  }

  /** Сообщение сотрудника в чат линии его токеном; не участник — сначала входит в диалог. */
  private async postToLine(user: B24UserContext, b24ChatId: number, text: string): Promise<void> {
    const post = () => user.client.call('im.message.add', { DIALOG_ID: `chat${b24ChatId}`, MESSAGE: text });
    try {
      await post();
    } catch (err) {
      if (!(err instanceof Bitrix24Error)) throw err;
      await user.client.call('imopenlines.session.join', { CHAT_ID: b24ChatId });
      await post();
    }
  }

  private async message(m: Messenger, messageId: string): Promise<MessengerMessage> {
    const row = await this.prisma.messengerMessage.findFirst({ where: { messengerId: m.id, OR: [{ id: messageId }, { externalId: messageId }] } });
    if (!row) throw new NotFoundException({ code: 'MESSAGE_NOT_FOUND', message: 'Сообщение не найдено' });
    return row;
  }
}

export function toMessageDto(r: MessengerMessage): MessengerMessageDto {
  return {
    dealId: r.dealId ?? null,
    awaitingDeal: r.awaitingDeal ?? false,
    id: r.id,
    externalId: r.externalId,
    chatId: r.chatId,
    fromMe: r.fromMe,
    body: r.body,
    type: r.type,
    hasMedia: r.hasMedia,
    media: r.hasMedia ? { mime: r.mediaMime ?? 'application/octet-stream', name: r.mediaName, size: r.mediaSize } : null,
    sentAt: r.sentAt.toISOString(),
    ack: r.ack,
    editedAt: r.editedAt?.toISOString() ?? null,
    edits: (r.edits as { at: string; body: string }[] | null) ?? [],
    deletedAt: r.deletedAt?.toISOString() ?? null,
    source: r.source as MessengerMessageDto['source'],
    relayError: r.relayError,
  };
}
