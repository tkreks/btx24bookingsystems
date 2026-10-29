import { mappedContactField } from '../bitrix24/contact-field-map.js';
import { contactFieldOf, contactFieldTarget } from '../bitrix24/messenger-contact-fields.js';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { chatNotWorkingMessage, lineOf, lineProblem } from '../openlines/line-health.js';
import { MESSENGER_MAX_FILE_BYTES, messengerLabel, normalizeMessengerLogin, normalizeMessengerPhone, type MessengerBindChatsDto, type MessengerBindResultDto, type MessengerChatTargetsDto, type MessengerDealTargetsDto, type MessengerDealTargetVia, type MessengerContactSearchDto, type MessengerChatDto, type MessengerLinkDto, type MessengerMessageDto, type MessengerSendResultDto } from '@btx24/shared';
import type { Messenger, MessengerMessage } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AccessService } from '../access/access.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { Bitrix24Error } from '../bitrix24/rest/errors.js';
import { MessengerConnectorService } from './messenger-connector.service.js';
import { APP_TELEGRAM_ID, MessengerCrmService, WZ_TELEGRAM_ID, WZ_TELEGRAM_LOGIN } from './messenger-crm.service.js';
import { MessengerInboxService } from './messenger-inbox.service.js';
import { MessengerServiceClient } from './messenger-service.client.js';
import { toDto } from './messengers.service.js';
import { crmLinksOf, groupReactions } from '../openlines/chat-parsing.js';

const PAGE = 50;
/** «Привязать чат»: чатов номера за раз. */
const BIND_PAGE = 10;
export const groupIdsOf = (m: Messenger): string[] => (Array.isArray(m.groupIds) ? (m.groupIds as unknown[]).filter((x): x is string => typeof x === 'string') : []);

/**
 * Переписка мессенджеров (ADR 0014, решение владельца 2026-10-24):
 * - **номер привязан к своей открытой линии** — сотрудник пишет через линию Битрикс24 (`im.message.add`
 *   его токеном: действие видно в Битрикс24), линия присылает событие коннектору, приложение доставляет
 *   в мессенджер (очередь). Права на чаты — права линии; в обход линии читают только администраторы.
 * - **не привязан** — отправка запрещена (решение владельца 2026-10-26: сообщения приложения — только через
 *   рабочие открытые линии); входящие по-прежнему видны в приложении группам номера.
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

  /**
   * Поиск только по разрешённым номерам; проверка регистрации ничего не отправляет. Номер — во всех
   * мессенджерах; логин (`@user`) — только в Telegram (у WhatsApp и MAX логинов нет).
   */
  async search(user: B24UserContext, input: unknown, loginInput?: unknown): Promise<MessengerContactSearchDto> {
    const phone = loginInput ? null : normalizeMessengerPhone(input);
    const login = phone ? null : normalizeMessengerLogin(loginInput ?? input);
    if (!phone && !login)
      throw new BadRequestException({ code: 'INVALID_PHONE', message: 'Укажите номер с кодом страны или логин Telegram (@имя)' });
    const [all, access] = await Promise.all([this.available(user), this.access.resolve(user)]);
    const rows = login ? all.filter(m => m.kind === 'telegram') : all;
    const results = await Promise.all(rows.map(async m => {
      const messenger = toDto(m, null);
      const permitted = access.isAppAdmin || access.groups.some(g => groupIdsOf(m).includes(g.group.id) && g.permissions.includes('openlines.send'));
      try {
        const found = login ? await this.service.contactByLogin(m.id, login) : await this.service.contact(m.id, phone!);
        if (!found.exists) return { messenger, status: 'not_found' as const, chatId: null, canSend: false, note: null, openlineChatId: null };
        const known = phone ? await this.prisma.messengerChat.findFirst({ where: { portalId: user.portal.id, messengerId: m.id, phone }, orderBy: { lastMessageAt: 'desc' } }) : null;
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
    if (this.crm && phone) {
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
    return { phone: phone ?? '', login, results, existingChats };
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
   * Не привязан или линия не работает — ошибка «создайте работающий чат».
   */
  async send(user: B24UserContext, m: Messenger, to: string, text: string, expectedDeal?: number | null, forDeal?: number): Promise<MessengerSendResultDto> {
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
    await this.requireWorkingLine(user, m);
    // Из встройки сделки: клиент чата — контакт сделки (до первого сообщения, чтобы линия не создала нового).
    const link = forDeal !== undefined && this.crm ? await this.crm.linkForDeal(user, forDeal) : null;
    if (link) {
      await this.crm!.pin(m, known?.chatId ?? target, link, known?.phone ?? (target.endsWith('@c.us') ? target.replace(/@.*$/, '') : null));
      expectedDeal = link.dealId ?? undefined;
    }
    const dealId = this.crm ? await this.crm.sending(user, m, known?.chatId ?? target, expectedDeal) : undefined;
    const b24ChatId = await this.lineChatOf(m, known?.chatId ?? target, dealId);
    if (b24ChatId) {
      await this.postToLine(user, b24ChatId, body);
      return { message: null, queued: true, openlineChatId: b24ChatId };
    }
    const first = await this.connector.firstContact(user, m, sendTo, body, undefined, dealId, link?.contactId);
    return { message: toMessageDto(first), queued: false, openlineChatId: first.b24ChatId ?? null };
  }

  /**
   * Куда написать клиенту сделки (встройка сделки, прежний канал не работает): номера со своей линией,
   * с которых сотрудник может писать. Адрес — уже связанный с контактом чат, Telegram ID и логин из CRM
   * (их записывал прежний провайдер), телефоны контакта. Проверка ничего клиенту не отправляет.
   */
  async dealTargets(user: B24UserContext, dealId: number): Promise<MessengerDealTargetsDto> {
    const deal = (await user.client.call<{ ID?: string; CONTACT_ID?: string | null }>('crm.deal.get', { id: dealId })).result;
    if (!deal?.ID) throw new NotFoundException({ code: 'DEAL_NOT_FOUND', message: `Сделка #${dealId} не найдена` });
    const contactId = Number(deal.CONTACT_ID) || 0;
    if (!contactId) return { dealId, contact: null, targets: [] };
    return { dealId, ...(await this.contactTargets(user, contactId)) };
  }

  /**
   * Неработающий чат открытой линии (канал Wazzup не подключён): через какой наш номер продолжить.
   * Номер — по сопоставлению линии с нашим каналом (`ChatLineChannel`, ADR 0017: линия ↔ один аккаунт
   * мессенджера); не сопоставлена — все номера сотрудника. Клиент — контакт чата, иначе контакт его сделки.
   */
  async chatTargets(user: B24UserContext, b24ChatId: number): Promise<MessengerChatTargetsDto> {
    const dialog = (await user.client.call<{ id?: number; entity_id?: string; entity_data_2?: string }>('imopenlines.dialog.get', { CHAT_ID: b24ChatId })).result;
    if (!dialog?.id) throw new ForbiddenException({ code: 'NO_CHAT_ACCESS', message: 'Нет доступа к диалогу' });
    const crm = crmLinksOf(dialog.entity_data_2);
    const line = lineOf(dialog.entity_id)?.line ?? null;
    const channel = line ? ((await this.prisma.chatLineChannel.findUnique({ where: { portalId_lineId: { portalId: user.portal.id, lineId: line } } }))?.channel ?? null) : null;
    const [kind, phone] = channel && !channel.startsWith('line:') ? channel.split(':') : [null, null];
    let contactId = crm.contactId ?? 0;
    if (!contactId && crm.dealId) contactId = Number((await user.client.call<{ CONTACT_ID?: string | null }>('crm.deal.get', { id: crm.dealId })).result?.CONTACT_ID) || 0;
    const base = { chatId: b24ChatId, dealId: crm.dealId ?? null, channel: kind ? channel : null };
    if (!contactId) return { ...base, contact: null, targets: [] };
    return { ...base, ...(await this.contactTargets(user, contactId, kind ? (m) => m.kind === kind && m.phone === phone : undefined)) };
  }

  /** Номера со своей линией, с которых сотрудник может писать, и адрес клиента-контакта в каждом. */
  private async contactTargets(user: B24UserContext, contactId: number, only?: (m: Messenger) => boolean): Promise<Pick<MessengerDealTargetsDto, 'contact' | 'targets'>> {
    const c = (await user.client.call<Record<string, unknown> & { NAME?: string | null; LAST_NAME?: string | null; PHONE?: { VALUE?: string }[] }>('crm.contact.get', { id: contactId })).result;
    const name = [c?.NAME, c?.LAST_NAME].filter(Boolean).join(' ').trim() || `Контакт #${contactId}`;
    const phones = [...new Set((c?.PHONE ?? []).map((p) => normalizeMessengerPhone(p.VALUE)).filter((p): p is string => !!p))];
    const contactMap = this.crm ? await this.crm.contactFields(user.portal.id) : {};
    const tgId = String(c?.[mappedContactField('telegram', contactMap) ?? APP_TELEGRAM_ID] || c?.[WZ_TELEGRAM_ID] || '').trim();
    const tgLogin = c?.[contactMap.telegramLogin ?? WZ_TELEGRAM_LOGIN] ? normalizeMessengerLogin(c[contactMap.telegramLogin ?? WZ_TELEGRAM_LOGIN]) : null;
    const rows = (await this.available(user)).filter((m) => m.lineMode === 'own' && m.lineId && (!only || only(m)));
    const can = await this.sendable(user, rows);
    const targets = await Promise.all(rows.filter((m) => can.has(m.id)).map(async (m): Promise<MessengerDealTargetsDto['targets'][number]> => {
      const messenger = toDto(m, null);
      try {
        let to: string | null = null;
        let via: MessengerDealTargetVia | null = null;
        const linked = await this.prisma.messengerChat.findFirst({ where: { portalId: user.portal.id, messengerId: m.id, crmContactId: contactId, NOT: { chatId: { endsWith: '@g.us' } } }, orderBy: { lastMessageAt: 'desc' } });
        if (linked) [to, via] = [linked.chatId, 'chat'];
        const ownField = contactFieldOf(m.kind);
        const ownTarget = ownField ? contactFieldTarget(m.kind, c?.[mappedContactField(m.kind, contactMap) ?? ownField.code]) : null;
        const lid = String(c?.[contactMap.whatsappLid ?? 'UF_CRM_WHATSAPPLID_WZ'] ?? '');
        if (!to && m.kind === 'whatsapp' && /^\d{1,20}$/.test(lid)) [to, via] = [`${lid}@lid`, 'chat'];
        const maxId = String(c?.[contactMap.max ?? 'UF_CRM_MAXID_WZ'] ?? '');
        if (!to && m.kind === 'max' && /^\d{1,20}$/.test(maxId)) [to, via] = [`${maxId}@lid`, 'chat'];
        if (!to && ownTarget) [to, via] = [ownTarget, m.kind === 'telegram' ? 'telegram' : 'chat'];
        if (!to && m.kind === 'telegram' && /^\d+$/.test(tgId)) [to, via] = [`${tgId}@lid`, 'telegram'];
        if (!to && m.kind === 'telegram' && tgLogin) {
          const f = await this.service.contactByLogin(m.id, tgLogin);
          if (f.exists && f.chatId) [to, via] = [f.chatId, 'login'];
        }
        for (const p of phones) {
          if (to) break;
          const f = await this.service.contact(m.id, p);
          if (f.exists) [to, via] = [f.chatId ?? `${p}@c.us`, 'phone'];
        }
        if (!to) return { messenger, status: 'not_found', to: null, via: null, openlineChatId: null, note: null };
        const lineChat = await this.lineChatOf(m, to);
        let openlineChatId: number | null = null;
        if (lineChat) {
          try { if ((await user.client.call<{ id?: number }>('imopenlines.dialog.get', { CHAT_ID: lineChat })).result?.id) openlineChatId = lineChat; } catch { /* Права линии проверяет портал. */ }
        }
        return { messenger, status: 'found', to, via, openlineChatId, note: via === 'telegram' ? 'ID Telegram из карточки клиента' : null };
      } catch {
        return { messenger, status: 'unavailable', to: null, via: null, openlineChatId: null, note: 'Не удалось проверить: проверьте подключение номера' };
      }
    }));
    return { contact: { id: contactId, name }, targets };
  }

  /**
   * «Привязать чат» (встройка сделки): последние чаты номера по 10 или поиск по всем его чатам (имя,
   * номер, ID). Личные чаты — группы мессенджера к клиенту не привязываются. Привязка — действие
   * отправителя: нужно право писать с номера; чаты своей линии — только доступные сотруднику в Битрикс24.
   */
  async bindChats(user: B24UserContext, id: string, q: string | undefined, offset: number): Promise<MessengerBindChatsDto> {
    const { m, admin } = await this.forUser(user, id, true);
    const text = String(q ?? '').trim().slice(0, 100);
    const digits = text.replace(/\D/g, '');
    const where = {
      messengerId: m.id,
      NOT: { chatId: { endsWith: '@g.us' } },
      ...(text ? { OR: [{ name: { contains: text } }, { chatId: { contains: text } }, ...(digits.length >= 3 ? [{ phone: { contains: digits } }] : [])] } : {}),
    };
    const rows = await this.prisma.messengerChat.findMany({ where, orderBy: { lastMessageAt: 'desc' }, skip: Math.max(0, offset), take: BIND_PAGE + 1 });
    const page = rows.slice(0, BIND_PAGE);
    const allowed = admin || m.lineMode !== 'own'
      ? page
      : (await Promise.all(page.map(async (row) => {
          try { await this.forUser(user, id, true, row.chatId); return row; } catch { return null; }
        }))).filter((row): row is (typeof page)[number] => row !== null);
    return {
      items: allowed.map((c) => ({ chatId: c.chatId, phone: c.phone, name: c.name, lastMessageAt: c.lastMessageAt?.toISOString() ?? null, lastText: c.lastText, unread: c.unread, contactId: c.crmContactId })),
      hasMore: rows.length > BIND_PAGE,
      nextOffset: Math.max(0, offset) + page.length,
    };
  }

  /**
   * Привязать чат мессенджера к клиенту сделки (контакт сделки). Чат уже связан с другим клиентом (в
   * приложении или его диалог в линии — с другим контактом) — не привязываем: диалог линии к другому
   * контакту REST не перепривязать, менеджеру — объединить контакты. У клиента есть другие сделки в
   * работе — привязываем и подсказываем объединить сделки. Клиенту ничего не отправляется.
   */
  async bindChat(user: B24UserContext, m: Messenger, chatId: string, dealId: number): Promise<MessengerBindResultDto> {
    if (!this.crm) throw new ConflictException({ code: 'CRM_UNAVAILABLE', message: 'Связь с CRM недоступна' });
    if (chatId.endsWith('@g.us')) throw new BadRequestException({ code: 'GROUP_CHAT', message: 'Группу мессенджера нельзя привязать к клиенту' });
    const link = await this.crm.linkForDeal(user, dealId);
    const row = await this.prisma.messengerChat.findUnique({ where: { messengerId_chatId: { messengerId: m.id, chatId } } });
    if (!row) throw new NotFoundException({ code: 'CHAT_NOT_FOUND', message: 'Чат мессенджера не найден' });
    const others = new Set<number>();
    if (row.crmContactId && row.crmContactId !== link.contactId) others.add(row.crmContactId);
    const lineChat = await this.lineChatOf(m, chatId);
    if (lineChat) {
      try {
        const d = (await user.client.call<{ entity_data_2?: string }>('imopenlines.dialog.get', { CHAT_ID: lineChat })).result;
        const bound = crmLinksOf(d?.entity_data_2).contactId;
        if (bound && bound !== link.contactId) others.add(bound);
      } catch { /* Нет доступа к диалогу — судим по связи в приложении. */ }
    }
    if (others.size) {
      const ids = [link.contactId, ...others];
      const contacts = await this.contactNames(user, ids);
      const deals = await this.openDeals(user, [...others], null);
      return {
        linked: false,
        message: `Чат уже связан с другим клиентом (${[...others].map((x) => contacts.find((c) => c.id === x)?.name ?? `#${x}`).join(', ')}). Объедините контакты${deals.length ? ' и сделки' : ''} в Битрикс24 — тогда чат будет у клиента этой сделки`,
        merge: { contacts, deals },
      };
    }
    await this.crm.pin(m, chatId, link, row.phone);
    const deals = await this.openDeals(user, [link.contactId], dealId);
    return {
      linked: true,
      message: deals.length ? `Чат привязан к клиенту. У клиента есть другие сделки в работе (${deals.length}) — при необходимости объедините сделки` : 'Чат привязан к клиенту сделки',
      merge: deals.length ? { contacts: [], deals } : null,
    };
  }

  private async contactNames(user: B24UserContext, ids: number[]): Promise<{ id: number; name: string }[]> {
    const rows = (await user.client.call<{ ID: string; NAME?: string | null; LAST_NAME?: string | null }[]>('crm.contact.list', { filter: { '@ID': ids }, select: ['ID', 'NAME', 'LAST_NAME'] }).catch(() => ({ result: [] }))).result ?? [];
    return ids.map((id) => {
      const r = rows.find((x) => Number(x.ID) === id);
      return { id, name: (r && [r.NAME, r.LAST_NAME].filter(Boolean).join(' ').trim()) || `Контакт #${id}` };
    });
  }

  /** Сделки в работе контактов (кроме `except`) — правами сотрудника. */
  private async openDeals(user: B24UserContext, contactIds: number[], except: number | null): Promise<{ id: number; title: string }[]> {
    const rows = (await user.client.call<{ ID: string; TITLE?: string }[]>('crm.deal.list', { filter: { '@CONTACT_ID': contactIds, STAGE_SEMANTIC_ID: 'P' }, select: ['ID', 'TITLE'], order: { ID: 'DESC' } }).catch(() => ({ result: [] }))).result ?? [];
    return rows.filter((d) => Number(d.ID) !== except).slice(0, 10).map((d) => ({ id: Number(d.ID), title: d.TITLE || `Сделка #${d.ID}` }));
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
    await this.requireWorkingLine(user, m);
    const dealId = this.crm ? await this.crm.sending(user, m, known?.chatId ?? target, expectedDeal) : undefined;
    const caption = String(text ?? '').trim().slice(0, 1024);
    const first = await this.connector.firstContact(user, m, sendTo, caption, file, dealId);
    return { message: toMessageDto(first), queued: false, openlineChatId: first.b24ChatId ?? null };
  }

  /**
   * Сообщения приложения клиенту — только через рабочие открытые линии (решение владельца 2026-10-26,
   * заменяет «номер без линии пишет напрямую»): номер привязан к своей линии, подключён, линия рабочая.
   */
  private async requireWorkingLine(user: B24UserContext, m: Messenger): Promise<void> {
    const label = `${messengerLabel(m.kind)} +${m.phone ?? ''}`.trim();
    if (m.lineMode !== 'own' || !m.lineId)
      throw new ConflictException({ code: 'NO_OPENLINE', message: `Номер ${label} не привязан к открытой линии — сообщения уходят только через рабочие открытые линии. Привяжите номер к линии в настройках мессенджеров` });
    if (m.state !== 'ready') throw new ConflictException({ code: 'CHAT_NOT_WORKING', message: chatNotWorkingMessage(`номер ${label} не подключён`) });
    const problem = await lineProblem(user.client, this.prisma, user.portal.id, `btx24_${m.kind}`, m.lineId);
    if (problem) throw new ConflictException({ code: 'CHAT_NOT_WORKING', message: chatNotWorkingMessage(problem) });
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
      const name = String(body.name ?? '').trim().slice(0, 255) || `${messengerLabel(m.kind)} +${m.phone}`;
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
    authorName: r.authorName ?? null,
    reactions: groupReactions(r.reactions),
  };
}
