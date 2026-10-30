import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { BookingVersionsDto, Permission, RecreateBookingResultDto } from '@btx24/shared';
import type { BookingRecord } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AccessService, type GroupAccess } from '../access/access.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { Bitrix24Error } from '../bitrix24/rest/errors.js';
import { dealLinks, getBooking } from './bitrix-bookings.js';
import { BookingJournalService, stateOf, type BookingState } from './booking-journal.service.js';
import { DealBookingFieldsService, userFieldsContext } from './deal-booking-fields.service.js';

/** Код пересечения броней в Битрикс24. */
const OVERLAP = '1018';
const VERSIONS_MAX = 20;

/**
 * Решения по брони приложения, которая разошлась с Битрикс24 (до решения она видна в календаре):
 * - `recreate` — пропала в Битрикс24: создать там заново по данным журнала или по выбранной версии;
 *   у брони новый ID — он переписывается в журнал и счета приложения;
 * - `rollback` — изменили в Битрикс24: вернуть бронь к выбранной версии из истории (время, ресурсы,
 *   сделка);
 * - `removeInApp` — согласиться с удалением: бронь отменяется в журнале (статус и история остаются).
 * Права — в группе ресурса брони (ресурс состоит ровно в одной группе); токен сотрудника.
 * После решения поля броней сделки (номер/даты ближайшей брони, «Брони сделки») пересчитываются по
 * журналу — `DealBookingFieldsService.refresh`, сбой записи — предупреждение.
 */
@Injectable()
export class BookingRestoreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly journal: BookingJournalService,
    private readonly dealBookings: DealBookingFieldsService,
  ) {}

  /** Версии данных брони для «Откатить» и «Истории изменений» (по прежнему ID — тоже). */
  async versions(user: B24UserContext, bookingId: number, offset: number, limit: number): Promise<BookingVersionsDto> {
    const record = await this.journal.findAny(user.portal.id, bookingId);
    if (!record) throw new NotFoundException({ code: 'BOOKING_NOT_FOUND', message: 'Бронь не найдена в журнале приложения' });
    const { items, hasMore } = await this.journal.versions(record, Math.max(0, offset), Math.min(Math.max(1, limit), VERSIONS_MAX));
    return { bookingId: record.bookingId, items, hasMore };
  }

  async recreate(user: B24UserContext, bookingId: number, versionId?: string): Promise<RecreateBookingResultDto> {
    const record = await this.missingRecord(user, bookingId, 'booking.create');
    const state = versionId ? await this.versionOf(user, record, versionId) : stateOf(record);
    const warnings: string[] = [];
    const tz = user.portal.timezone;
    let newId: number;
    try {
      const res = await user.client.call<number | { id?: number }>('booking.v1.booking.add', {
        fields: {
          resourceIds: state.resourceIds,
          name: record.title || (state.dealId ? `Сделка #${state.dealId}` : 'Служебная: блокировка'),
          description: '',
          datePeriod: period(state, tz),
        },
      });
      newId = typeof res.result === 'object' && res.result !== null ? Number(res.result.id) : Number(res.result);
    } catch (err) {
      if (err instanceof Bitrix24Error && String(err.code) === OVERLAP)
        throw new ConflictException({ code: 'BOOKING_OVERLAP', message: 'Время уже занято другой бронью этого ресурса — создать заново нельзя' });
      throw err;
    }

    if (state.dealId) {
      try {
        await user.client.call('booking.v1.booking.externalData.set', {
          bookingId: newId,
          externalData: [{ moduleId: 'crm', entityTypeId: 'DEAL', value: String(state.dealId) }],
        });
      } catch (err) {
        // Без связи со сделкой бронь «чужая» для приложения — откатываем, слот свободен.
        await user.client.call('booking.v1.booking.delete', { id: newId }).catch(() => undefined);
        throw err;
      }
      const deal = (await user.client.call<{ CONTACT_ID?: string | null }>('crm.deal.get', { id: state.dealId }).catch(() => null))?.result;
      const contactId = Number(deal?.CONTACT_ID) || 0;
      if (contactId)
        await user.client
          .call('booking.v1.booking.client.set', { bookingId: newId, clients: [{ id: contactId, type: { module: 'crm', code: 'CONTACT' } }] })
          .catch(() => warnings.push('Клиент не привязан к брони в Битрикс24'));
    }

    const actor = { kind: 'user' as const, userId: user.userId, name: user.userName };
    const recreated = await this.journal.recordRecreated(record, newId, actor);
    // Создали по прежней версии — данные журнала следуют за ней.
    if (versionId) await this.journal.recordChanged(recreated, state, actor, 'rolled_back', 'app');
    // Счета приложения по брони — на новый ID (оплата и снятие за неоплату находят бронь по нему).
    await this.prisma.paymentRequest.updateMany({ where: { portalId: user.portal.id, bookingId }, data: { bookingId: newId } });
    warnings.push(...(await this.refreshDeals(user, [record.dealId, state.dealId])));
    return { previousBookingId: bookingId, bookingId: newId, warnings };
  }

  /** «Откатить» изменение, сделанное в Битрикс24: бронь там возвращается к версии из истории. */
  async rollback(user: B24UserContext, bookingId: number, versionId: string): Promise<string[]> {
    const record = await this.journal.find(user.portal.id, bookingId);
    if (!record || record.status !== 'active')
      throw new NotFoundException({ code: 'BOOKING_NOT_FOUND', message: 'Активной брони с таким номером в приложении нет — возможно, решение уже принято' });
    const raw = await getBooking(user.client, bookingId);
    if (!raw) return (await this.recreate(user, bookingId, versionId)).warnings;
    await this.allowed(user, record, 'booking.edit');
    const state = await this.versionOf(user, record, versionId);
    const tz = user.portal.timezone;
    const warnings: string[] = [];
    try {
      await user.client.call('booking.v1.booking.update', { id: bookingId, fields: { resourceIds: state.resourceIds, datePeriod: period(state, tz) } });
    } catch (err) {
      if (err instanceof Bitrix24Error)
        throw new ConflictException({ code: 'ROLLBACK_FAILED', message: `Битрикс24 не принял прежнюю версию брони: ${err.message}` });
      throw err;
    }
    const linked = (await dealLinks(user.client, [bookingId])).get(bookingId) ?? null;
    if (linked !== state.dealId) {
      if (state.dealId)
        await user.client.call('booking.v1.booking.externalData.set', {
          bookingId,
          externalData: [{ moduleId: 'crm', entityTypeId: 'DEAL', value: String(state.dealId) }],
        });
      else await user.client.call('booking.v1.booking.externalData.unset', { bookingId });
    }
    await this.journal.recordChanged(record, state, { kind: 'user', userId: user.userId, name: user.userName }, 'rolled_back', 'app');
    // Прежняя сделка (бронь могла уйти из неё) и сделка версии.
    warnings.push(...(await this.refreshDeals(user, [record.dealId, state.dealId])));
    return warnings;
  }

  /** Согласиться с удалением в Битрикс24: отменить бронь в приложении. */
  async removeInApp(user: B24UserContext, bookingId: number): Promise<string[]> {
    const record = await this.missingRecord(user, bookingId, 'booking.cancel');
    await this.journal.recordCancelled(user.portal.id, bookingId, {
      reason: 'removed_in_bitrix',
      actor: { kind: 'user', userId: user.userId, name: user.userName },
    });
    return this.refreshDeals(user, [record.dealId]);
  }

  /** Активная запись журнала, которой нет в Битрикс24, и право в группе её ресурса. */
  private async missingRecord(user: B24UserContext, bookingId: number, permission: Permission): Promise<BookingRecord> {
    const record = await this.journal.find(user.portal.id, bookingId);
    if (!record || record.status !== 'active')
      throw new NotFoundException({ code: 'BOOKING_NOT_FOUND', message: 'Активной брони с таким номером в приложении нет — возможно, решение уже принято' });
    await this.allowed(user, record, permission);
    if (await getBooking(user.client, bookingId))
      throw new ConflictException({ code: 'BOOKING_EXISTS', message: 'Бронь есть в Битрикс24 — решать по ней нечего' });
    return record;
  }

  private async allowed(user: B24UserContext, record: BookingRecord, permission: Permission): Promise<void> {
    const a = await this.access.resolve(user);
    if (!a.isAppAdmin && !groupOf(a.groups, (record.resourceIds as number[]).map(Number), permission))
      throw new ForbiddenException({ code: 'NO_BOOKING_ACCESS', message: 'Нет права на это действие в группе ресурса брони' });
  }

  /** Выбранная версия; её ресурсы тоже должны быть в группе, где у сотрудника есть право. */
  private async versionOf(user: B24UserContext, record: BookingRecord, versionId: string): Promise<BookingState> {
    const state = await this.journal.version(record, versionId);
    if (!state) throw new BadRequestException({ code: 'UNKNOWN_VERSION', message: 'Такой версии у брони нет' });
    const a = await this.access.resolve(user);
    if (!a.isAppAdmin && !groupOf(a.groups, state.resourceIds, 'booking.edit'))
      throw new ForbiddenException({ code: 'NO_BOOKING_ACCESS', message: 'Нет права менять брони ресурса этой версии' });
    return state;
  }

  private async refreshDeals(user: B24UserContext, dealIds: (number | null)[]): Promise<string[]> {
    const warnings: string[] = [];
    for (const id of new Set(dealIds)) if (id) warnings.push(...(await this.dealBookings.refresh(userFieldsContext(user), id)));
    return warnings;
  }

}

function period(s: BookingState, timezone: string) {
  return {
    from: { timestamp: Math.floor(Date.parse(s.startsAt) / 1000), timezone },
    to: { timestamp: Math.floor(Date.parse(s.endsAt) / 1000), timezone },
  };
}

function groupOf(groups: GroupAccess[], resourceIds: number[], permission: Permission): GroupAccess | null {
  return groups.find((g) => g.permissions.includes(permission) && resourceIds.some((id) => g.group.resourceIds.includes(id))) ?? null;
}
