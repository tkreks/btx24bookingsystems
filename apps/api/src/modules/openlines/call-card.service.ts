import { BadRequestException, Injectable } from '@nestjs/common';
import type { ActiveCallDto, CallCardDto } from '@btx24/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AccessService } from '../access/access.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { Bitrix24Error } from '../bitrix24/rest/errors.js';
import { ClientBookingsService } from '../bookings/client-bookings.service.js';
import { ChatsService, phoneVariants } from './chats.service.js';

/** Звонок «идёт», если ответили не раньше — и нет конца (событие конца могло потеряться). */
const ACTIVE_MS = 2 * 3_600_000;
const LAST_MESSAGES = 6;

/**
 * Карточка звонка (решение владельца 2026-10-23): по номеру клиента и привязке CRM из окна звонка
 * (встройка `CALL_CARD`) или из события ответа на звонок — клиент, его брони и сделки (цвет для новой
 * брони), чаты и последние сообщения. Всё — правами сотрудника, недоступное просто не показывается.
 */
@Injectable()
export class CallCardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly chats: ChatsService,
    private readonly clients: ClientBookingsService,
  ) {}

  /** Звонки, на которые сотрудник ответил и которые ещё не закончились. */
  async active(user: B24UserContext): Promise<ActiveCallDto[]> {
    const rows = await this.prisma.telephonyCall.findMany({
      where: { portalId: user.portal.id, userId: user.userId, endedAt: null, answeredAt: { gt: new Date(Date.now() - ACTIVE_MS) } },
      orderBy: { answeredAt: 'desc' },
      take: 3,
    });
    return rows.map((r) => ({ callId: r.callId, phone: r.phone, callType: r.callType, answeredAt: r.answeredAt!.toISOString() }));
  }

  async card(user: B24UserContext, q: { phone?: unknown; entityType?: unknown; entityId?: unknown; callId?: unknown }): Promise<CallCardDto> {
    let phone = typeof q.phone === 'string' && q.phone.trim() ? q.phone.trim() : null;
    if (!phone && typeof q.callId === 'string' && q.callId)
      phone = (await this.prisma.telephonyCall.findUnique({ where: { portalId_callId: { portalId: user.portal.id, callId: q.callId.slice(0, 100) } } }))?.phone ?? null;
    const type = String(q.entityType ?? '').toUpperCase();
    const entityId = Number(q.entityId) || 0;
    if (!phone && !entityId) throw new BadRequestException({ code: 'NO_CLIENT', message: 'Нет номера клиента и привязки к CRM' });

    // Клиент: контакт из привязки звонка, контакт сделки звонка, иначе — поиск по номеру.
    let contactId = type === 'CONTACT' ? entityId : 0;
    let dealId = type === 'DEAL' ? entityId : 0;
    if (dealId && !contactId) {
      const deal = await user.client.call<{ CONTACT_ID?: string | null }>('crm.deal.get', { id: dealId }).catch(() => null);
      contactId = Number(deal?.result?.CONTACT_ID) || 0;
    }
    if (!contactId && phone) {
      const variants = phoneVariants(phone);
      if (variants.length) {
        const found = await user.client
          .call<{ CONTACT?: number[] }>('crm.duplicate.findbycomm', { entity_type: 'CONTACT', type: 'PHONE', values: variants })
          .catch(() => null);
        contactId = Number(found?.result?.CONTACT?.[0]) || 0;
      }
    }

    const a = await this.access.resolve(user);
    const can = (p: string) => a.isAppAdmin || a.groups.some((g) => g.permissions.includes(p as never));
    const [client, chats] = await Promise.all([
      contactId || dealId ? this.clients.forContact(user, contactId || null, dealId ? [dealId] : []).catch(rest(null)) : Promise.resolve(null),
      can('openlines.read') && phone && phoneVariants(phone).length
        ? this.chats.searchByPhone(user, { q: phone }).then((r) => r.items, rest([]))
        : Promise.resolve([]),
    ]);
    const latest = [...chats].sort((x, y) => Date.parse(y.lastMessage?.date ?? '0') - Date.parse(x.lastMessage?.date ?? '0'))[0];
    const history = latest ? await this.chats.history(user, latest.chatId, {}, false).catch(rest(null)) : null;
    // Сделка для брони: сделка звонка (Битрикс24 создаёт её на новый звонок), иначе самая новая открытая.
    const open = [...(client?.openDeals ?? [])].sort((x, y) => Date.parse(y.createdAt ?? '0') - Date.parse(x.createdAt ?? '0') || y.id - x.id);
    const suggested = dealId && open.some((d) => d.id === dealId) ? dealId : (open[0]?.id ?? null);
    return {
      phone,
      contact: client?.contact ?? (contactId ? { id: contactId, name: null } : null),
      client,
      suggestedDealId: suggested,
      chats,
      messages: history && latest ? { chatId: latest.chatId, title: latest.clientName || latest.title, items: history.messages.slice(-LAST_MESSAGES) } : null,
    };
  }
}

/** Ошибка Битрикс24 (нет прав, нет модуля) — пустое значение; остальное — дальше. */
function rest<T>(fallback: T) {
  return (e: unknown): T => {
    if (e instanceof Bitrix24Error) return fallback;
    throw e;
  };
}
