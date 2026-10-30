import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import type { CancelBookingResultDto } from '@btx24/shared';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AccessService } from '../access/access.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { Bitrix24Error } from '../bitrix24/rest/errors.js';
import { dealLinks, getBooking } from './bitrix-bookings.js';
import { BookingJournalService } from './booking-journal.service.js';
import { DealBookingFieldsService, userFieldsContext } from './deal-booking-fields.service.js';

/** Код Битрикс24 «Booking not found» (как в `getBooking`). */
const BOOKING_NOT_FOUND = '1021';

const cancelSchema = z.object({ groupId: z.string().min(1).max(40), comment: z.string().trim().max(500).optional() }).strict();

/**
 * Снять бронь (кнопка в карточке брони): удалить в Битрикс24 — слот свободен — и отменить в
 * журнале приложения со статусом и историей (не бесследно). Токен сотрудника: его права, режим
 * «только чтение» и песочница. Повтор безопасен: уже снятая бронь — тот же результат.
 */
@Injectable()
export class BookingCancelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly journal: BookingJournalService,
    @Optional() private readonly dealBookings?: DealBookingFieldsService,
  ) {}

  async cancel(user: B24UserContext, bookingId: number, body: unknown): Promise<CancelBookingResultDto> {
    const parsed = cancelSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ code: 'INVALID_CANCEL', message: 'Ожидается { groupId, comment? }' });
    const a = await this.access.resolve(user);
    const g = this.access.pick(a, parsed.data.groupId, 'booking.cancel');
    if (!g) throw new ForbiddenException({ code: 'NO_BOOKING_CANCEL', message: 'Нет права снимать брони в этой группе' });
    const actor = { kind: 'user' as const, userId: user.userId, name: user.userName };
    const cancel = { reason: 'manual' as const, actor, comment: parsed.data.comment || undefined };
    const warnings: string[] = [];

    const raw = await getBooking(user.client, bookingId);
    if (!raw) {
      // Уже удалена (повтор нажатия или удалили в Битрикс24) — закрываем у нас, если ещё активна.
      const rec = await this.journal.find(user.portal.id, bookingId);
      if (!rec) throw new NotFoundException({ code: 'BOOKING_NOT_FOUND', message: 'Бронь не найдена' });
      if (rec.status === 'active') await this.journal.recordCancelled(user.portal.id, bookingId, cancel);
      return { bookingId, warnings: ['Бронь уже была снята в Битрикс24', ...(await this.refreshDeal(user, rec.dealId))] };
    }
    const resourceIds = (raw.resourceIds ?? []).map(Number);
    if (!resourceIds.some((id) => g.group.resourceIds.includes(id)))
      throw new ForbiddenException({ code: 'BOOKING_NOT_IN_GROUP', message: 'Бронь не из ресурсов этой группы' });

    // Бронь, созданную мимо приложения и ещё не попавшую в журнал, сначала записываем — чтобы
    // у отмены была история.
    const dealId = (await dealLinks(user.client, [bookingId])).get(bookingId) ?? null;
    const imported = await this.journal.recordImported(user.portal.id, {
      bookingId,
      kind: dealId ? 'client' : 'service',
      dealId,
      groupId: g.group.id,
      resourceIds,
      startsAt: new Date(Number(raw.datePeriod?.from?.timestamp ?? 0) * 1000),
      endsAt: new Date(Number(raw.datePeriod?.to?.timestamp ?? 0) * 1000),
      title: raw.name ?? null,
    });

    try {
      await user.client.call('booking.v1.booking.delete', { id: bookingId });
    } catch (err) {
      if (err instanceof Bitrix24Error && err.code === 'READ_ONLY_MODE')
        throw new ForbiddenException({ code: 'BOOKING_READ_ONLY', message: 'Снимать эту бронь приложению пока не разрешено: можно только брони, созданные приложением' });
      // 1021 «Booking not found»: параллельная отмена успела удалить бронь между get и delete —
      // цель достигнута, доводим отмену как обычно (запись журнала и ожидания оплаты — идемпотентны).
      if (!(err instanceof Bitrix24Error && String(err.code) === BOOKING_NOT_FOUND)) throw err;
    }
    // Отменяет только активную запись (updateMany по статусу): вторая отмена историю не задваивает.
    await this.journal.recordCancelled(user.portal.id, bookingId, cancel);

    // Ожидание оплаты по этой брони больше не нужно: иначе по сроку клиенту уйдёт «не оплачено».
    const waiting = await this.prisma.paymentRequest.findMany({ where: { portalId: user.portal.id, bookingId, status: { in: ['link_pending', 'sent'] } } });
    if (waiting.length) {
      await this.prisma.paymentRequest.updateMany({
        where: { id: { in: waiting.map((r) => r.id) } },
        data: { status: 'cancelled', error: 'Бронь снята сотрудником — ожидание оплаты снято', closedAt: new Date() },
      });
      for (const r of waiting)
        if (r.invoiceId) warnings.push(`Счёт #${r.invoiceId} остался — при необходимости переведите его в «Не оплачен»`);
    }
    // Поля броней сделки: номер/даты ближайшей действующей брони и список — без снятой.
    // Сделка по журналу могла отличаться от связи в Битрикс24 — пересчитываем обе.
    for (const id of new Set([dealId, imported?.record?.dealId ?? null])) warnings.push(...(await this.refreshDeal(user, id)));
    return { bookingId, warnings };
  }

  private async refreshDeal(user: B24UserContext, dealId: number | null): Promise<string[]> {
    return dealId && this.dealBookings ? this.dealBookings.refresh(userFieldsContext(user), dealId) : [];
  }
}
