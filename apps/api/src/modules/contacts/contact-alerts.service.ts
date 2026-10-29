import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import type { ContactActorDto, ContactAlertListDto, ContactChangeDto } from '@btx24/shared';
import type { Portal } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import type { Bitrix24RestClient } from '../bitrix24/rest/rest-client.js';
import { CrmAccessService } from '../crm-mirror/crm-access.service.js';
import { selectedPeriod } from '../../common/period.js';
import { ActionLogService } from '../audit/action-log.service.js';

const STATUSES = ['new', 'viewed', 'resolved', 'ignored'] as const;
@Injectable()
export class ContactAlertsService {
  constructor(private readonly prisma: PrismaService, @Optional() private readonly access?: CrmAccessService, @Optional() private readonly actions?: ActionLogService) {}
  async list(user: B24UserContext, query: Record<string, unknown>): Promise<ContactAlertListDto> {
    const status = typeof query.status === 'string' && query.status ? query.status : null;
    if (status && !STATUSES.some(s => s === status)) throw new BadRequestException('Неизвестный статус уведомления');
    const period = selectedPeriod(query, user.portal.timezone);
    const where = { portalId: user.portal.id, ...(period ? { createdAt: { gte: period.start, lt: period.end } } : {}), ...(status ? { status } : {}) };
    const before = typeof query.before === 'string' ? await this.prisma.contactAlert.findFirst({ where: { id: query.before, portalId: user.portal.id } }) : null;
    const [rows, grouped, settings] = await Promise.all([
      this.prisma.contactAlert.findMany({ where: { ...where, ...(before ? { OR: [{ createdAt: { lt: before.createdAt } }, { createdAt: before.createdAt, id: { lt: before.id } }] } : {}) }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 51 }),
      this.prisma.contactAlert.groupBy({ by: ['status'], where: { portalId: user.portal.id, ...(period ? { createdAt: { gte: period.start, lt: period.end } } : {}) }, _count: true }),
      this.prisma.portalSettings.findUnique({ where: { portalId: user.portal.id } }),
    ]);
    const allowed = this.access ? await this.access.visible(user, 3, rows.map(r => r.contactId)) : new Set<number>();
    const names = new Map((await this.prisma.crmEntity.findMany({ where: { portalId: user.portal.id, entityTypeId: 3, entityId: { in: rows.map(r => r.contactId).filter(id => allowed.has(id)) } }, select: { entityId: true, title: true } })).map(e => [e.entityId, e.title]));
    const meta = rows.some(r => allowed.has(r.contactId)) ? (await user.client.call<Record<string, { formLabel?: string; listLabel?: string; title?: string }>>('crm.contact.fields')).result : {};
    const counts = { new: 0, viewed: 0, resolved: 0, ignored: 0 };
    for (const g of grouped) if (STATUSES.some(s => s === g.status)) counts[g.status as keyof typeof counts] = g._count;
    return { counts, nextCursor: rows.length > 50 ? rows[49].id : null, chatConfigured: !!settings?.alertChatId, items: rows.slice(0, 50).map(row => {
      const permitted = allowed.has(row.contactId);
      const changes = permitted && Array.isArray(row.changes) ? row.changes as unknown as ContactChangeDto[] : [];
      const unknown: ContactActorDto = { source: 'bitrix', accountId: null, accountName: null, accountType: 'unknown', attribution: 'unknown', application: null };
      return { id: row.id, contactId: row.contactId, kind: row.kind as 'change' | 'deleted' | 'missing', status: row.status as typeof STATUSES[number], createdAt: row.createdAt.toISOString(), changes: changes.map(c => ({ ...c, label: meta[c.field]?.formLabel || meta[c.field]?.listLabel || meta[c.field]?.title || c.field })), actor: permitted ? row.actor as unknown as ContactActorDto : unknown, restricted: !permitted, delivered: row.messageId !== null, sendError: row.sendError, contactName: permitted ? (names.get(row.contactId) ?? null) : null };
    }) };
  }
  async setStatus(user: B24UserContext, id: string, status: string): Promise<{ ok: true }> {
    const row = await this.prisma.contactAlert.findFirst({ where: { portalId: user.portal.id, id } });
    if (!row) throw new NotFoundException('Уведомление не найдено');
    if (!STATUSES.some(s => s === status)) throw new BadRequestException('Неизвестный статус');
    await this.prisma.contactAlert.update({ where: { id }, data: { status, statusByUserId: user.userId, statusAt: new Date() } });
    await this.actions?.user(user, { action: 'contact.alert_status', summary: `Контакт #${row.contactId}: изменён статус предупреждения`, entityType: 'contact', entityId: row.contactId, details: { alertId: id, before: row.status, after: status } });
    return { ok: true };
  }
  /** Статус нескольким уведомлениям портала (до 200); чужие и неизвестные ID пропускаются. */
  async setStatusMany(user: B24UserContext, ids: string[], status: string): Promise<{ updated: number }> {
    if (!STATUSES.some(s => s === status)) throw new BadRequestException('Неизвестный статус');
    let updated = 0;
    for (const id of [...new Set(ids)].slice(0, 200)) {
      const row = await this.prisma.contactAlert.findFirst({ where: { portalId: user.portal.id, id }, select: { status: true } });
      if (!row || row.status === status) continue;
      await this.setStatus(user, id, status);
      updated++;
    }
    return { updated };
  }
  async deliverPending(portal: Portal, client: Bitrix24RestClient): Promise<void> {
    const settings = await this.prisma.portalSettings.findUnique({ where: { portalId: portal.id } });
    if (!settings?.alertChatId) return;
    const pending = await this.prisma.contactAlert.findMany({ where: { portalId: portal.id, messageId: null, status: { in: ['new', 'viewed'] }, createdAt: { gte: new Date(Date.now() - 3 * 86400_000) } }, orderBy: { createdAt: 'asc' }, take: 20 });
    for (const alert of pending) {
      const actor = alert.actor as unknown as ContactActorDto;
      const who = actor.attribution === 'last_editor' ? `Последний редактор: ${actor.accountType === 'system_user' ? 'системная учётная запись ' : 'учётная запись ' }#${actor.accountId}` : 'Автор действия не установлен';
      const count = Array.isArray(alert.changes) ? alert.changes.length : 0;
      const message = `Контакт #${alert.contactId}: ${alert.kind === 'deleted' ? 'УДАЛЁН в Битрикс24' : alert.kind === 'missing' ? 'не возвращён Битрикс24 — проверьте доступность/удаление' : `изменение известных данных (${count} полей)`}.\n${who}.\nПодробности — в уведомлениях приложения и журнале действий. Значения контакта не изменяются приложением.`;
      try {
        const result = await client.call<number>('im.message.add', { DIALOG_ID: `chat${settings.alertChatId}`, MESSAGE: message, URL_PREVIEW: 'N' });
        const messageId = Number(result.result);
        if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new Error('Invalid message ID');
        await this.prisma.contactAlert.update({ where: { id: alert.id }, data: { messageId, sendError: null } });
        await this.actions?.log(portal.id, { kind: 'system', name: 'Приложение' }, { action: 'contact.alert_delivered', summary: `Контакт #${alert.contactId}: отправлено предупреждение`, entityType: 'contact', entityId: alert.contactId, via: 'app', details: { alertId: alert.id, messageId, automation: 'contact-alerts', operationId: alert.id, executionAccountId: portal.installedByUserId, initiator: null } });
      } catch { await this.prisma.contactAlert.update({ where: { id: alert.id }, data: { sendError: 'Не удалось доставить уведомление; будет повторено' } }); }
    }
  }
}
