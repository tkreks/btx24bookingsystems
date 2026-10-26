import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { clientPhoneVariants, normalizeClientPhone, type MessengerClientContextDto } from '@btx24/shared';
import type { Messenger, Portal } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { PortalService } from '../bitrix24/portals/portal.service.js';
import type { Bitrix24RestClient } from '../bitrix24/rest/rest-client.js';

type Contact = { ID: string; NAME?: string; LAST_NAME?: string; SECOND_NAME?: string };
type Comm = { VALUE?: string };
/**
 * Где прежний провайдер (Wazzup) хранил Telegram-клиента: поле контакта с ID пользователя Telegram и
 * почта `<ID>@telegram.wazzup`. Telegram часто не показывает номер — по ним находим старого клиента.
 */
export const WZ_TELEGRAM_ID = 'UF_CRM_TELEGRAMID_WZ';
export const WZ_TELEGRAM_LOGIN = 'UF_CRM_TELEGRAMUSERNAME_WZ';
const wzTelegramEmail = (id: string) => `${id}@telegram.wazzup`;
/** ID пользователя Telegram из ID чата (`<id>@lid`); у групп и других мессенджеров — null. */
export const telegramIdOf = (kind: string, chatId: string): string | null => (kind === 'telegram' ? (/^(\d+)@lid$/.exec(chatId)?.[1] ?? null) : null);
/** Кто клиент чата для поиска в CRM: номер, ID Telegram, уже известные контакты. */
export type ChatIdentity = { telegramId?: string | null; contactIds?: number[] };
type Deal = { ID: string; TITLE: string; CONTACT_ID?: string; STAGE_SEMANTIC_ID?: string; OPPORTUNITY?: string; CURRENCY_ID?: string };
const key = (m: Messenger, chatId: string) => ({ messengerId_chatId: { messengerId: m.id, chatId } });

/** CRM остаётся источником истины. В фоне сохраняются только ID, интерфейс перечитывает CRM правами сотрудника. */
@Injectable()
export class MessengerCrmService {
  constructor(private readonly prisma: PrismaService, private readonly portals: PortalService) {}

  async match(client: Bitrix24RestClient, phone: string | null, activeOnly: boolean, who: ChatIdentity = {}): Promise<Pick<MessengerClientContextDto, 'contacts' | 'deals'>> {
    const values = phone ? clientPhoneVariants(phone) : [];
    const contactSet = new Set<number>(who.contactIds ?? []);
    const companySet = new Set<number>();
    if (values.length) {
      const found = (await client.call<{ CONTACT?: number[]; COMPANY?: number[] }>('crm.duplicate.findbycomm', { type: 'PHONE', values })).result;
      for (const id of found?.CONTACT ?? []) contactSet.add(Number(id));
      for (const id of found?.COMPANY ?? []) companySet.add(Number(id));
    }
    if (who.telegramId) for (const id of await this.byTelegram(client, who.telegramId)) contactSet.add(id);
    const contactIds = [...contactSet].filter(n => n > 0);
    const companyIds = [...companySet].filter(n => n > 0);
    if (!contactIds.length && !companyIds.length) return { contacts: [], deals: [] };
    const contacts: Contact[] = [];
    for (let start = 0; contactIds.length; ) {
      const r = await client.call<Contact[]>('crm.contact.list', { filter: { '@ID': contactIds }, select: ['ID', 'NAME', 'LAST_NAME', 'SECOND_NAME'], start });
      contacts.push(...r.result);
      if (r.next == null) break; start = r.next;
    }
    const deals = new Map<number, Deal>();
    // Пустой фильтр никогда не отправляем: иначе он вернул бы все сделки портала.
    for (const filter of [contactIds.length ? { '@CONTACT_ID': contactIds } : null, companyIds.length ? { '@COMPANY_ID': companyIds } : null]) {
      if (!filter) continue;
      for (let start = 0; ; ) {
        const r = await client.call<Deal[]>('crm.deal.list', { filter: { ...filter, ...(activeOnly ? { STAGE_SEMANTIC_ID: 'P' } : {}) }, select: ['ID', 'TITLE', 'CONTACT_ID', 'STAGE_SEMANTIC_ID', 'OPPORTUNITY', 'CURRENCY_ID'], order: { ID: 'DESC' }, start });
        for (const d of r.result) deals.set(Number(d.ID), d);
        if (r.next == null) break; start = r.next;
      }
    }
    return { contacts: contacts.map(c => ({ id: Number(c.ID), name: [c.LAST_NAME, c.NAME, c.SECOND_NAME].filter(Boolean).join(' ') || `Контакт #${c.ID}` })), deals: [...deals.values()].map(d => ({ id: Number(d.ID), title: d.TITLE, contactId: Number(d.CONTACT_ID) || null, active: d.STAGE_SEMANTIC_ID === 'P', opportunity: d.OPPORTUNITY == null ? null : Number(d.OPPORTUNITY), currency: d.CURRENCY_ID ?? null })) };
  }

  /** Контакты, которых прежний провайдер записал с этим ID Telegram (поле и почта). */
  private async byTelegram(client: Bitrix24RestClient, telegramId: string): Promise<number[]> {
    const out = new Set<number>();
    const byEmail = (await client.call<{ CONTACT?: number[] }>('crm.duplicate.findbycomm', { type: 'EMAIL', values: [wzTelegramEmail(telegramId)] })).result;
    for (const id of byEmail?.CONTACT ?? []) out.add(Number(id));
    // Фильтр по полю, которого нет на портале, Битрикс24 молча пропускает (пришли бы все контакты) — сверяем значение.
    const byField = await client.call<Record<string, unknown>[]>('crm.contact.list', { filter: { [WZ_TELEGRAM_ID]: telegramId }, select: ['ID', WZ_TELEGRAM_ID] });
    for (const c of byField.result ?? []) if (String(c[WZ_TELEGRAM_ID] ?? '') === telegramId) out.add(Number(c.ID));
    return [...out].filter(n => n > 0);
  }

  /** Телефон и почта контакта (токеном приложения): по ним линия свяжет новый диалог с этим клиентом. */
  async comms(portal: Portal, contactId: number): Promise<{ phone: string | null; email: string | null }> {
    const c = (await this.portals.clientFor(portal).call<{ PHONE?: Comm[]; EMAIL?: Comm[] }>('crm.contact.get', { id: contactId })).result;
    const first = (list?: Comm[]) => list?.map(x => String(x.VALUE ?? '').trim()).find(Boolean) ?? null;
    return { phone: first(c?.PHONE), email: first(c?.EMAIL) };
  }

  /**
   * Новый чат к клиенту сделки: сделка и её контакт — правами сотрудника. Активная сделка становится
   * выбранной в чате, контакт — клиентом чата (по нему линия свяжет диалог, `MessengerConnectorService`).
   */
  async linkForDeal(user: B24UserContext, dealId: number): Promise<{ dealId: number | null; contactId: number }> {
    const deal = (await user.client.call<{ ID?: string; CONTACT_ID?: string | null; STAGE_SEMANTIC_ID?: string }>('crm.deal.get', { id: dealId })).result;
    if (!deal?.ID) throw new BadRequestException({ code: 'DEAL_NOT_FOUND', message: `Сделка #${dealId} не найдена` });
    const contactId = Number(deal.CONTACT_ID) || 0;
    if (!contactId) throw new BadRequestException({ code: 'DEAL_WITHOUT_CONTACT', message: 'У сделки нет контакта — укажите клиента в сделке' });
    return { dealId: deal.STAGE_SEMANTIC_ID === 'P' ? dealId : null, contactId };
  }

  /** Связать чат мессенджера с клиентом (и сделкой) до первого сообщения. */
  async pin(m: Messenger, chatId: string, link: { dealId: number | null; contactId: number }, phone?: string | null) {
    const data = { crmContactId: link.contactId, ...(link.dealId ? { activeDealId: link.dealId } : {}) };
    await this.prisma.messengerChat.upsert({ where: key(m, chatId), create: { portalId: m.portalId, messengerId: m.id, chatId, phone: phone ?? null, ...data }, update: data });
  }

  /** Маршрут нового входящего фиксируется один раз, последующая смена сделки не переписывает историю. */
  async route(m: Messenger, chatId: string, inputPhone?: string | null) {
    let chat = await this.prisma.messengerChat.findUnique({ where: key(m, chatId) });
    const phone = normalizeClientPhone(inputPhone ?? chat?.phone ?? (/^(\d+)@c\.us$/.exec(chatId)?.[1]));
    const telegramId = telegramIdOf(m.kind, chatId);
    if ((!phone && !telegramId && !chat?.crmContactId) || chatId.endsWith('@g.us')) return { dealId: null, awaitingDeal: false };
    if (!chat && phone) {
      // WA меняет адрес по номеру на LID: выбор сделки принадлежит клиенту, а не форме адреса.
      const alias = await this.prisma.messengerChat.findFirst({ where: { portalId: m.portalId, messengerId: m.id, phone }, orderBy: { lastMessageAt: 'desc' } });
      chat = await this.prisma.messengerChat.upsert({ where: key(m, chatId), create: { portalId: m.portalId, messengerId: m.id, chatId, phone, ...(alias ? { activeDealId: alias.activeDealId, crmContactId: alias.crmContactId, ...(alias.crmMatch ? { crmMatch: alias.crmMatch } : {}), crmMatchedAt: alias.crmMatchedAt } : {}) }, update: {} });
    }
    if (!chat?.crmMatchedAt || Date.now() - chat.crmMatchedAt.getTime() > 60_000) {
      const portal = await this.prisma.portal.findFirst({ where: { id: m.portalId, status: 'ACTIVE' } });
      if (!portal) return { dealId: null, awaitingDeal: true };
      try {
        const prev = chat?.crmContactId ?? null;
        const matched = await this.match(this.portals.clientFor(portal), phone, true, { telegramId, contactIds: prev ? [prev] : [] });
        const ids = matched.deals.map(d => d.id);
        const activeDealId = chat?.activeDealId && ids.includes(chat.activeDealId) ? chat.activeDealId : ids.length === 1 ? ids[0] : null;
        const contacts = matched.contacts.map(c => c.id);
        // Уже связанный клиент (выбран из сделки или найден раньше) остаётся, пока контакт существует.
        const crmContactId = prev && contacts.includes(prev) ? prev : contacts.length === 1 ? contacts[0] : null;
        if (!chat) chat = await this.prisma.messengerChat.upsert({ where: key(m, chatId), create: { portalId: m.portalId, messengerId: m.id, chatId }, update: {} });
        // CAS: не затираем выбор сотрудника, сделанный во время запроса к CRM.
        await this.prisma.messengerChat.updateMany({ where: { portalId: m.portalId, messengerId: m.id, chatId, activeDealId: chat.activeDealId }, data: { ...(phone ? { phone } : {}), crmContactId, activeDealId, crmMatch: { dealIds: ids }, crmMatchedAt: new Date() } });
        chat = (await this.prisma.messengerChat.findUnique({ where: key(m, chatId) }))!;
      } catch { return { dealId: null, awaitingDeal: true }; }
    }
    if (!chat) return { dealId: null, awaitingDeal: false };
    const ids = (chat.crmMatch as { dealIds?: number[] } | null)?.dealIds ?? [];
    return { dealId: chat.activeDealId, awaitingDeal: ids.length > 1 && !chat.activeDealId };
  }

  async context(user: B24UserContext, m: Messenger, chatId: string): Promise<MessengerClientContextDto> {
    const chat = await this.prisma.messengerChat.findFirst({ where: { portalId: user.portal.id, messengerId: m.id, chatId } });
    const phone = normalizeClientPhone(chat?.phone ?? (/^(\d+)@c\.us$/.exec(chatId)?.[1]));
    const pending = await this.prisma.messengerMessage.count({ where: { portalId: user.portal.id, messengerId: m.id, chatId, awaitingDeal: true } });
    const telegramId = telegramIdOf(m.kind, chatId);
    const contactIds = chat?.crmContactId ? [chat.crmContactId] : [];
    if (!phone && !telegramId && !contactIds.length) return { phone: null, contacts: [], deals: [], activeDealId: null, needsChoice: false, pending, note: 'Номер клиента пока неизвестен' };
    const found = await this.match(user.client, phone, false, { telegramId, contactIds });
    const activeDealId = found.deals.some(d => d.id === chat?.activeDealId && d.active) ? chat!.activeDealId : null;
    return { phone, ...found, activeDealId, needsChoice: found.deals.some(d => d.active) && !activeDealId, pending, note: null };
  }

  async choose(user: B24UserContext, m: Messenger, chatId: string, dealId: number): Promise<MessengerClientContextDto> {
    const ctx = await this.context(user, m, chatId);
    if (!ctx.deals.some(d => d.id === dealId && d.active)) throw new BadRequestException({ code: 'INVALID_CLIENT_DEAL', message: 'Выберите доступную активную сделку этого клиента' });
    await this.prisma.$transaction(async tx => {
      await tx.messengerChat.upsert({ where: key(m, chatId), create: { portalId: m.portalId, messengerId: m.id, chatId, phone: ctx.phone, activeDealId: dealId }, update: { activeDealId: dealId } });
      await tx.messengerMessage.updateMany({ where: { portalId: m.portalId, messengerId: m.id, chatId, awaitingDeal: true }, data: { dealId, awaitingDeal: false } });
    });
    return { ...ctx, activeDealId: dealId, needsChoice: false, pending: 0 };
  }

  /** Защита от отправки в старую сделку после переключения другим сотрудником. */
  async sending(user: B24UserContext, m: Messenger, chatId: string, expected?: number | null): Promise<number | null> {
    const ctx = await this.context(user, m, chatId);
    if (ctx.needsChoice || (expected !== undefined && expected !== ctx.activeDealId)) throw new ConflictException({ code: 'CHOOSE_CLIENT_DEAL', message: 'Выберите сделку клиента перед отправкой сообщения' });
    return ctx.activeDealId;
  }
}
