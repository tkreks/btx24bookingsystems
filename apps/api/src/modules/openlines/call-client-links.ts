import type { CallLogRowDto } from '@btx24/shared';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import type { BatchCommand } from '../bitrix24/rest/rest-client.js';
import { phoneVariants, type ChatsService } from './chats.service.js';

/** Дополняем только видимые дела звонков. Все связи/права проверяются токеном сотрудника. */
export async function callClientLinks(user: B24UserContext, chats: ChatsService, rows: CallLogRowDto[], canReadChats: boolean): Promise<CallLogRowDto[]> {
  const contactFor = new Map<number, number[]>();
  const ownerDeals = [...new Set(rows.filter((r) => !r.contact && r.owner.typeId === 2).map((r) => r.owner.id))];
  const dealContacts = new Map<number, number>();
  if (ownerDeals.length) {
    const deals = await user.client.listAll<{ ID: string; CONTACT_ID?: string }>('crm.deal.list', {
      filter: { '@ID': ownerDeals }, select: ['ID', 'CONTACT_ID'],
    }).catch(() => []);
    for (const d of deals) if (Number(d.CONTACT_ID) > 0) dealContacts.set(Number(d.ID), Number(d.CONTACT_ID));
  }
  const lookup: Record<string, BatchCommand> = {};
  for (const r of rows) {
    const contactId = r.contact?.id || (r.owner.typeId === 3 ? r.owner.id : r.owner.typeId === 2 ? dealContacts.get(r.owner.id) : undefined);
    if (contactId) contactFor.set(r.activityId, [contactId]);
    else if (r.clientPhone && phoneVariants(r.clientPhone).length) lookup[`p${r.activityId}`] = {
      method: 'crm.duplicate.findbycomm', params: { entity_type: 'CONTACT', type: 'PHONE', values: phoneVariants(r.clientPhone).slice(0, 20) },
    };
  }
  if (Object.keys(lookup).length) {
    const found = await user.client.batch(lookup).catch(() => ({ result: {} as Record<string, unknown> }));
    for (const r of rows) {
      const match = found.result[`p${r.activityId}`] as { CONTACT?: number[] } | undefined;
      if (Array.isArray(match?.CONTACT)) contactFor.set(r.activityId, match.CONTACT.map(Number).filter((id) => id > 0));
    }
  }
  const ids = [...new Set([...contactFor.values()].flat())];
  const commands: Record<string, BatchCommand> = {};
  for (const id of ids) {
    // Нужна первая страница: DATE_CREATE, затем ID разрешает равные даты. Закрытые сделки тоже подходят.
    commands[`d${id}`] = { method: 'crm.deal.list', params: { filter: { CONTACT_ID: id }, order: { DATE_CREATE: 'DESC', ID: 'DESC' }, select: ['ID', 'DATE_CREATE'] } };
    if (canReadChats) commands[`c${id}`] = { method: 'imopenlines.crm.chat.get', params: { CRM_ENTITY_TYPE: 'contact', CRM_ENTITY: id, ACTIVE_ONLY: 'N' } };
  }
  const entityTypes: Record<number, string | undefined> = { 1: 'lead', 2: 'deal', 3: 'contact', 4: 'company' };
  for (const r of rows) if (canReadChats && entityTypes[r.owner.typeId] && r.owner.id > 0) {
    commands[`o${r.owner.typeId}_${r.owner.id}`] = { method: 'imopenlines.crm.chat.get', params: { CRM_ENTITY_TYPE: entityTypes[r.owner.typeId], CRM_ENTITY: r.owner.id, ACTIVE_ONLY: 'N' } };
  }
  const links = Object.keys(commands).length ? await user.client.batch(commands).catch(() => ({ result: {} as Record<string, unknown> })) : { result: {} as Record<string, unknown> };
  const readChats = (key: string): number[] => {
    const value = links.result[key];
    return Array.isArray(value) ? value.map((c: { CHAT_ID?: string | number }) => Number(c.CHAT_ID)).filter((n) => n > 0) : [];
  };
  const chatIds = (id: number) => readChats(`c${id}`);
  const ownerChats = (r: CallLogRowDto) => readChats(`o${r.owner.typeId}_${r.owner.id}`);
  const candidates = [...new Set([...ids.flatMap(chatIds), ...rows.flatMap(ownerChats)])];
  // summariesByChat сверяет доступ пользователя к каждому чату, недоступные не возвращает.
  const summaries = canReadChats && candidates.length ? await chats.summariesByChat(user, candidates).catch(() => []) : [];
  return rows.map((r) => {
    const contacts = contactFor.get(r.activityId) ?? [];
    const deals = contacts.flatMap((id) => {
      const value = links.result[`d${id}`];
      return Array.isArray(value) ? value.slice(0, 1) as { ID: string; DATE_CREATE?: string }[] : [];
    }).sort((a, b) => (Date.parse(b.DATE_CREATE ?? '') || 0) - (Date.parse(a.DATE_CREATE ?? '') || 0) || Number(b.ID) - Number(a.ID));
    const related = new Set([...contacts.flatMap(chatIds), ...ownerChats(r)]);
    const latest = summaries.filter((c) => related.has(c.chatId)).sort((a, b) =>
      (Date.parse(b.lastMessage?.date ?? '') || 0) - (Date.parse(a.lastMessage?.date ?? '') || 0) || b.chatId - a.chatId,
    )[0];
    return { ...r, clientAvatar: latest?.clientAvatar ?? r.contact?.photo ?? null, latestDealId: Number(deals[0]?.ID) || null, latestChatId: latest?.chatId ?? null };
  });
}
