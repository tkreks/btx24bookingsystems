import { Injectable, Logger } from '@nestjs/common';
import { autoSendAt, inSendWindow, renderMessage, type AutoMessageRule, type GroupOptionsDto, type TemplateStepDto } from '@btx24/shared';
import { Prisma, type BookingRecord, type Portal } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Bitrix24RestClient } from '../bitrix24/rest/rest-client.js';
import { BookingJournalService } from '../bookings/booking-journal.service.js';
import { msg, PaymentFlow, type FlowContext } from './payment-flow.js';

/** Самое раннее «за N часов» + сутки на сдвиг в окно: дальше брони не смотрим. */
const MAX_LOOKAHEAD_H = 24 * 15;
const MAX_BOOKINGS = 500;

/**
 * Автоматические рассылки (правила групп `options.autoMessages`), в worker: за `hoursBefore` до начала
 * клиентской брони, в рабочее окно по времени портала, — системный шаблон (назначение `auto`) в чат
 * открытой линии сделки, от имени ответственного за сделку. Одно сообщение на правило и бронь
 * (`AutoMessageLog`, запись до отправки — повтор прохода не задвоит). Бронь, сделанная позже срока
 * («за сутки» для брони через 5 часов), и бронь, пропавшая в Битрикс24, — без рассылки.
 */
@Injectable()
export class AutoMessagesService {
  private readonly logger = new Logger(AutoMessagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly flow: PaymentFlow,
    private readonly journal: BookingJournalService,
  ) {}

  async run(portal: Portal, client: Bitrix24RestClient, now = Date.now()): Promise<{ sent: number; failed: number }> {
    const out = { sent: 0, failed: 0 };
    const groups = (await this.prisma.workGroup.findMany({ where: { portalId: portal.id, archivedAt: null }, include: { resources: true } }))
      .map((g) => ({ resourceIds: g.resources.map((r) => r.resourceId), rules: ((g.options as GroupOptionsDto | null)?.autoMessages ?? []).filter((r) => r.enabled) }))
      .filter((g) => g.rules.length);
    if (!groups.length) return out;
    const tz = portal.timezone;
    const records = await this.prisma.bookingRecord.findMany({
      where: { portalId: portal.id, status: 'active', kind: 'client', dealId: { not: null }, startsAt: { gt: new Date(now), lte: new Date(now + MAX_LOOKAHEAD_H * 3600_000) } },
      orderBy: { startsAt: 'asc' },
      take: MAX_BOOKINGS,
    });
    const gone = await this.journal.pendingRemoval(portal.id, records.map((r) => r.bookingId));
    const ctx: FlowContext = { portal, client, actor: { kind: 'system', name: 'Система: автоматическая рассылка' } };
    for (const r of records) {
      if (gone.has(r.bookingId)) continue;
      const ids = (r.resourceIds as number[]).map(Number);
      // Группа брони — по её ресурсу (ресурс — ровно в одной группе).
      const rules = groups.find((g) => ids.some((id) => g.resourceIds.includes(id)))?.rules ?? [];
      for (const rule of rules) {
        if (!due(r, rule, tz, now)) continue;
        const res = await this.send(ctx, r, rule).catch((e: unknown) => {
          this.logger.warn(`booking ${r.bookingId} rule ${rule.id}: ${msg(e)}`);
          return 'failed' as const;
        });
        if (res === 'sent') out.sent++;
        else if (res === 'failed') out.failed++;
      }
    }
    return out;
  }

  /** null — уже отправляли (или отправляет параллельный проход). */
  private async send(ctx: FlowContext, r: BookingRecord, rule: AutoMessageRule): Promise<'sent' | 'failed' | null> {
    const dealId = r.dealId!;
    let log;
    try {
      log = await this.prisma.autoMessageLog.create({ data: { portalId: ctx.portal.id, ruleId: rule.id, bookingId: r.bookingId, dealId, status: 'sending' } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return null;
      throw e;
    }
    const warnings: string[] = [];
    const template = await this.prisma.messageTemplate.findFirst({ where: { id: rule.templateId, portalId: ctx.portal.id, purpose: 'auto' } });
    let ok = false;
    if (!template) warnings.push('Шаблон рассылки удалён');
    else {
      const mc = await this.flow.messages(ctx, dealId);
      const steps = await this.flow.withFileData(
        ctx.portal.id,
        (template.steps as unknown as TemplateStepDto[]).map((st) => ({ text: renderMessage(st.text, mc), files: st.fileIds.map((fileId) => ({ fileId, name: '' })) })),
        warnings,
      );
      ok = await this.flow.sendChain(ctx, { dealId, userId: null, source: 'auto' }, mc.deal, steps, warnings);
      await this.flow.comment(
        ctx,
        dealId,
        `Автоматическая рассылка «${rule.name}» по брони #${r.bookingId} ${ok ? 'отправлена клиенту' : `НЕ отправлена: ${warnings.join('; ') || 'ошибка'}`}:\n${steps.map((x) => x.text).filter(Boolean).join('\n\n')}`,
        warnings,
      );
    }
    await this.prisma.autoMessageLog.update({
      where: { id: log.id },
      data: { status: ok ? 'sent' : 'failed', sentAt: ok ? new Date() : null, error: ok ? null : (warnings.join('; ') || 'не отправлено').slice(0, 1000) },
    });
    return ok ? 'sent' : 'failed';
  }
}

/** Пора отправлять: наступил срок, сейчас рабочее окно, бронь сделали раньше срока. */
export function due(r: Pick<BookingRecord, 'startsAt' | 'createdAt'>, rule: AutoMessageRule, tz: string, now: number): boolean {
  const start = r.startsAt.getTime();
  if (start <= now) return false;
  // Бронь сделали позже, чем «за N часов» до начала: напоминание не про неё.
  if (r.createdAt.getTime() > start - rule.hoursBefore * 3600_000) return false;
  const at = autoSendAt(start, rule, tz);
  return at !== null && now >= at && inSendWindow(now, rule, tz);
}
