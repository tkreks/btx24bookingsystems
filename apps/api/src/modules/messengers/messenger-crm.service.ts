import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { clientPhoneVariants, normalizeClientPhone, type MessengerClientContextDto } from '@btx24/shared';
import type { Messenger } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { PortalService } from '../bitrix24/portals/portal.service.js';
import type { Bitrix24RestClient } from '../bitrix24/rest/rest-client.js';

type Contact = { ID: string; NAME?: string; LAST_NAME?: string; SECOND_NAME?: string };
type Deal = { ID: string; TITLE: string; CONTACT_ID?: string; STAGE_SEMANTIC_ID?: string; OPPORTUNITY?: string; CURRENCY_ID?: string };
const key = (m: Messenger, chatId: string) => ({ messengerId_chatId: { messengerId: m.id, chatId } });

/** CRM остаётся источником истины. В фоне сохраняются только ID, интерфейс перечитывает CRM правами сотрудника. */
@Injectable()
export class MessengerCrmService {
  constructor(private readonly prisma: PrismaService, private readonly portals: PortalService) {}

  async match(client: Bitrix24RestClient, phone: string, activeOnly: boolean): Promise<Pick<MessengerClientContextDto, 'contacts' | 'deals'>> {
    const values = clientPhoneVariants(phone);
    if (!values.length) return { contacts: [], deals: [] };
    const found = (await client.call<{ CONTACT?: number[]; COMPANY?: number[] }>('crm.duplicate.findbycomm', { type: 'PHONE', values })).result;
    const contactIds = [...new Set(found?.CONTACT ?? [])].map(Number).filter(n => n > 0);
    const companyIds = [...new Set(found?.COMPANY ?? [])].map(Number).filter(n => n > 0);
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

  /** Маршрут нового входящего фиксируется один раз, последующая смена сделки не переписывает историю. */
  async route(m: Messenger, chatId: string, inputPhone?: string | null) {
    let chat = await this.prisma.messengerChat.findUnique({ where: key(m, chatId) });
    const phone = normalizeClientPhone(inputPhone ?? chat?.phone ?? (/^(\d+)@c\.us$/.exec(chatId)?.[1]));
    if (!phone || chatId.endsWith('@g.us')) return { dealId: null, awaitingDeal: false };
    if (!chat) {
      // WA меняет адрес по номеру на LID: выбор сделки принадлежит клиенту, а не форме адреса.
      const alias = await this.prisma.messengerChat.findFirst({ where: { portalId: m.portalId, messengerId: m.id, phone }, orderBy: { lastMessageAt: 'desc' } });
      chat = await this.prisma.messengerChat.upsert({ where: key(m, chatId), create: { portalId: m.portalId, messengerId: m.id, chatId, phone, ...(alias ? { activeDealId: alias.activeDealId, crmContactId: alias.crmContactId, ...(alias.crmMatch ? { crmMatch: alias.crmMatch } : {}), crmMatchedAt: alias.crmMatchedAt } : {}) }, update: {} });
    }
    if (!chat.crmMatchedAt || Date.now() - chat.crmMatchedAt.getTime() > 60_000) {
      const portal = await this.prisma.portal.findFirst({ where: { id: m.portalId, status: 'ACTIVE' } });
      if (!portal) return { dealId: null, awaitingDeal: true };
      try {
        const matched = await this.match(this.portals.clientFor(portal), phone, true);
        const ids = matched.deals.map(d => d.id);
        const activeDealId = chat.activeDealId && ids.includes(chat.activeDealId) ? chat.activeDealId : ids.length === 1 ? ids[0] : null;
        // CAS: не затираем выбор сотрудника, сделанный во время запроса к CRM.
        await this.prisma.messengerChat.updateMany({ where: { portalId: m.portalId, messengerId: m.id, chatId, activeDealId: chat.activeDealId }, data: { phone, crmContactId: matched.contacts.length === 1 ? matched.contacts[0].id : null, activeDealId, crmMatch: { dealIds: ids }, crmMatchedAt: new Date() } });
        chat = (await this.prisma.messengerChat.findUnique({ where: key(m, chatId) }))!;
      } catch { return { dealId: null, awaitingDeal: true }; }
    }
    const ids = (chat.crmMatch as { dealIds?: number[] } | null)?.dealIds ?? [];
    return { dealId: chat.activeDealId, awaitingDeal: ids.length > 1 && !chat.activeDealId };
  }

  async context(user: B24UserContext, m: Messenger, chatId: string): Promise<MessengerClientContextDto> {
    const chat = await this.prisma.messengerChat.findFirst({ where: { portalId: user.portal.id, messengerId: m.id, chatId } });
    const phone = normalizeClientPhone(chat?.phone ?? (/^(\d+)@c\.us$/.exec(chatId)?.[1]));
    const pending = await this.prisma.messengerMessage.count({ where: { portalId: user.portal.id, messengerId: m.id, chatId, awaitingDeal: true } });
    if (!phone) return { phone: null, contacts: [], deals: [], activeDealId: null, needsChoice: false, pending, note: 'Номер клиента пока неизвестен' };
    const found = await this.match(user.client, phone, false);
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
