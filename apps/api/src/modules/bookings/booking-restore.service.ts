import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Permission, RecreateBookingResultDto } from '@btx24/shared';
import type { BookingRecord } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AccessService, type GroupAccess } from '../access/access.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { Bitrix24Error } from '../bitrix24/rest/errors.js';
import { getBooking } from './bitrix-bookings.js';
import { BookingJournalService } from './booking-journal.service.js';
import { DealFieldMapService } from './deal-field-map.service.js';

/** Код пересечения броней в Битрикс24. */
const OVERLAP = '1018';

/**
 * Решение по брони приложения, которую удалили в Битрикс24 (до решения она видна в календаре):
 * - `recreate` — создать бронь в Битрикс24 заново по данным журнала (ресурсы, время, сделка, клиент);
 *   у брони новый ID — он переписывается в журнал, счета приложения и поле «ID бронирования» сделки;
 * - `removeInApp` — согласиться с удалением: бронь отменяется в журнале (статус и история остаются).
 * Права — в группе ресурса брони (ресурс состоит ровно в одной группе); токен сотрудника.
 */
@Injectable()
export class BookingRestoreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly journal: BookingJournalService,
    private readonly fieldMap: DealFieldMapService,
  ) {}

  async recreate(user: B24UserContext, bookingId: number): Promise<RecreateBookingResultDto> {
    const record = await this.missingRecord(user, bookingId, 'booking.create');
    const resourceIds = (record.resourceIds as number[]).map(Number);
    const warnings: string[] = [];
    const tz = user.portal.timezone;
    let newId: number;
    try {
      const res = await user.client.call<number | { id?: number }>('booking.v1.booking.add', {
        fields: {
          resourceIds,
          name: record.title || (record.dealId ? `Сделка #${record.dealId}` : 'Служебная: блокировка'),
          description: '',
          datePeriod: {
            from: { timestamp: Math.floor(record.startsAt.getTime() / 1000), timezone: tz },
            to: { timestamp: Math.floor(record.endsAt.getTime() / 1000), timezone: tz },
          },
        },
      });
      newId = typeof res.result === 'object' && res.result !== null ? Number(res.result.id) : Number(res.result);
    } catch (err) {
      if (err instanceof Bitrix24Error && String(err.code) === OVERLAP)
        throw new ConflictException({ code: 'BOOKING_OVERLAP', message: 'Время уже занято другой бронью этого ресурса — создать заново нельзя' });
      throw err;
    }

    if (record.dealId) {
      try {
        await user.client.call('booking.v1.booking.externalData.set', {
          bookingId: newId,
          externalData: [{ moduleId: 'crm', entityTypeId: 'DEAL', value: String(record.dealId) }],
        });
      } catch (err) {
        // Без связи со сделкой бронь «чужая» для приложения — откатываем, слот свободен.
        await user.client.call('booking.v1.booking.delete', { id: newId }).catch(() => undefined);
        throw err;
      }
      const deal = (await user.client.call<{ CONTACT_ID?: string | null }>('crm.deal.get', { id: record.dealId }).catch(() => null))?.result;
      const contactId = Number(deal?.CONTACT_ID) || 0;
      if (contactId)
        await user.client
          .call('booking.v1.booking.client.set', { bookingId: newId, clients: [{ id: contactId, type: { module: 'crm', code: 'CONTACT' } }] })
          .catch(() => warnings.push('Клиент не привязан к брони в Битрикс24'));
      const map = await this.fieldMap.get(user.portal.id);
      if (map.bookingId)
        try {
          await user.client.call('crm.deal.update', { id: record.dealId, fields: { [map.bookingId]: String(newId) } });
        } catch (err) {
          if (!(err instanceof Bitrix24Error) || err.code !== 'READ_ONLY_MODE') throw err;
          warnings.push(`Поле «ID бронирования» сделки #${record.dealId} не обновлено: изменять существующие сделки не разрешено`);
        }
    }

    await this.journal.recordRecreated(record, newId, { kind: 'user', userId: user.userId, name: user.userName });
    // Счета приложения по брони — на новый ID (оплата и снятие за неоплату находят бронь по нему).
    await this.prisma.paymentRequest.updateMany({ where: { portalId: user.portal.id, bookingId }, data: { bookingId: newId } });
    return { previousBookingId: bookingId, bookingId: newId, warnings };
  }

  /** Согласиться с удалением в Битрикс24: отменить бронь в приложении. */
  async removeInApp(user: B24UserContext, bookingId: number): Promise<void> {
    await this.missingRecord(user, bookingId, 'booking.cancel');
    await this.journal.recordCancelled(user.portal.id, bookingId, {
      reason: 'removed_in_bitrix',
      actor: { kind: 'user', userId: user.userId, name: user.userName },
    });
  }

  /** Активная запись журнала, которой нет в Битрикс24, и право в группе её ресурса. */
  private async missingRecord(user: B24UserContext, bookingId: number, permission: Permission): Promise<BookingRecord> {
    const record = await this.journal.find(user.portal.id, bookingId);
    if (!record || record.status !== 'active')
      throw new NotFoundException({ code: 'BOOKING_NOT_FOUND', message: 'Активной брони с таким номером в приложении нет — возможно, решение уже принято' });
    const a = await this.access.resolve(user);
    if (!a.isAppAdmin && !groupOf(a.groups, record, permission))
      throw new ForbiddenException({ code: 'NO_BOOKING_ACCESS', message: 'Нет права на это действие в группе ресурса брони' });
    if (await getBooking(user.client, bookingId))
      throw new ConflictException({ code: 'BOOKING_EXISTS', message: 'Бронь есть в Битрикс24 — решать по ней нечего' });
    return record;
  }
}

function groupOf(groups: GroupAccess[], record: BookingRecord, permission: Permission): GroupAccess | null {
  const ids = (record.resourceIds as number[]).map(Number);
  return groups.find((g) => g.permissions.includes(permission) && ids.some((id) => g.group.resourceIds.includes(id))) ?? null;
}
