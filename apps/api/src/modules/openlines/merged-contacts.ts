import type { ChatCrmLinks } from '@btx24/shared';
import type { PrismaService } from '../../prisma/prisma.service.js';

const CONTACT = 3;

/**
 * Объединение дубликатов в Битрикс24 удаляет контакт, а привязка чата открытой линии
 * (`entity_data_2`) так и остаётся на удалённом. Сделка чата при этом переезжает на оставшийся
 * контакт — по копии CRM (ADR 0013) подменяем удалённый контакт контактом сделки. Без сделки
 * (или пока копия сделки не обновилась) привязка остаётся как есть. Меняет `links` на месте.
 */
export async function followMergedContacts(
  prisma: Pick<PrismaService, 'crmEntity' | 'crmDeal'>,
  portalId: string,
  links: (ChatCrmLinks | null | undefined)[],
): Promise<void> {
  const ids = [...new Set(links.flatMap((l) => (l?.contactId ? [l.contactId] : [])))];
  if (!ids.length) return;
  const gone = new Set(
    (await prisma.crmEntity.findMany({ where: { portalId, entityTypeId: CONTACT, entityId: { in: ids }, deletedAt: { not: null } }, select: { entityId: true } })).map((r) => r.entityId),
  );
  if (!gone.size) return;
  const dealIds = [...new Set(links.flatMap((l) => (l?.contactId && gone.has(l.contactId) && l.dealId ? [l.dealId] : [])))];
  if (!dealIds.length) return;
  const owner = new Map(
    (await prisma.crmDeal.findMany({ where: { portalId, dealId: { in: dealIds }, deletedAt: null }, select: { dealId: true, contactId: true } })).map((d) => [d.dealId, d.contactId]),
  );
  for (const l of links) {
    if (!l?.contactId || !l.dealId || !gone.has(l.contactId)) continue;
    const next = owner.get(l.dealId);
    if (next && !gone.has(next)) l.contactId = next;
  }
}
