import { createHash } from 'node:crypto';
import type { ContactActorDto, ContactChangeDto } from '@btx24/shared';
import type { Prisma } from '../../generated/prisma/client.js';

export function contactBusinessChanges(changes: ContactChangeDto[], before: Record<string, unknown>): ContactChangeDto[] {
  return changes.filter(c => c.field in before && !/^(ID|DATE_CREATE|DATE_MODIFY|MODIFY_BY_ID|CREATED_BY_ID|HAS_\w+|LAST_ACTIVITY_\w+|LAST_COMMUNICATION_\w+)$/.test(c.field));
}
export async function contactActor(tx: Prisma.TransactionClient, portalId: string, row: Record<string, unknown>, deleted = false): Promise<ContactActorDto> {
  const value = Number(row.MODIFY_BY_ID);
  const id = !deleted && Number.isSafeInteger(value) && value > 0 ? value : null;
  if (!id) return { source: 'bitrix', accountId: null, accountName: null, accountType: 'unknown', attribution: 'unknown', application: null };
  const [settings, employee] = await Promise.all([
    tx.portalSettings.findUnique({ where: { portalId }, select: { contactSystemUserIds: true } }),
    tx.portalEmployee.findUnique({ where: { portalId_userId: { portalId, userId: id } }, select: { name: true } }),
  ]);
  const system = Array.isArray(settings?.contactSystemUserIds) && settings.contactSystemUserIds.includes(id);
  return { source: 'bitrix', accountId: id, accountName: employee?.name ?? null, accountType: system ? 'system_user' : 'employee', attribution: 'last_editor', application: null };
}
export function contactFingerprint(contactId: number, kind: string, changes: ContactChangeDto[], version: unknown): string {
  return createHash('sha256').update(JSON.stringify([contactId, kind, version, changes])).digest('hex');
}
