import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import {
  canUsePaymentMode,
  DEAL_KIND_TYPE_VALUE,
  DEAL_KINDS,
  DEAL_KIND_LABELS,
  discountedPrice,
  detectBookingType,
  PROGRAM_FROM_KEYWORD,
  PAYMENT_MODE_LABELS,
  PAYMENT_MODES,
  type CreateBookingDto,
  type BookingProductInput,
  type CreateBookingResultDto,
  type DealFieldMapDto,
  type DealFormField,
  type GroupOptionsDto,
} from '@btx24/shared';
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AccessService } from '../access/access.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { TRANSIENT_CODES } from '../bitrix24/portals/portal.service.js';
import { Bitrix24Error } from '../bitrix24/rest/errors.js';
import { BookingJournalService } from './booking-journal.service.js';
import { ActionLogService } from '../audit/action-log.service.js';
import { DealFieldMapService } from './deal-field-map.service.js';
import { dealUpdateFields } from './deal-form.js';
import { DealFormService } from './deal-form.service.js';
import { ResourceStopsService } from './resource-stops.service.js';

const iso = z.string().refine((v) => Number.isFinite(Date.parse(v)), 'ISO-дата');
export const createSchema = z
  .object({
    idempotencyKey: z.string().min(8).max(64),
    groupId: z.string().min(1).max(40),
    kind: z.enum(['client', 'service']),
    resourceIds: z.array(z.number().int().positive()).min(1).max(10),
    start: iso,
    end: iso,
    dealId: z.number().int().positive().nullable().optional(),
    newDeal: z.object({ title: z.string().trim().min(1).max(255), contactId: z.number().int().positive().nullable().optional() }).strict().nullable().optional(),
    contactId: z.number().int().positive().nullable().optional(),
    guests: z.number().int().min(0).max(1000).nullable().optional(),
    comment: z.string().max(2000).optional(),
    products: z
      .array(
        z
          .object({
            productId: z.number().int().positive(),
            quantity: z.number().positive().max(10000),
            price: z.number().min(0).max(100_000_000),
            discountType: z.enum(['percent', 'sum']).optional(),
            discount: z.number().min(0).max(100_000_000).optional(),
          })
          .strict()
          .refine((p) => p.discountType !== 'percent' || (p.discount ?? 0) <= 100, { message: 'Скидка больше 100%' }),
      )
      .max(50)
      .optional(),
    paymentMode: z.enum(PAYMENT_MODES),
    bookingTypeId: z.string().min(1).max(40).nullable().optional(),
    dealFields: z.record(z.string().max(64), z.string().max(5000)).optional(),
    // «Покупка сертификата» — не бронь (продажа — `POST /certificates/sale`).
    dealKind: z.enum(DEAL_KINDS).exclude(['certificate']).nullable().optional(),
    prepaymentAmount: z.number().positive().max(10_000_000).nullable().optional(),
  })
  .strict()
  .refine((b) => Date.parse(b.end) > Date.parse(b.start), { message: 'Конец брони раньше начала', path: ['end'] })
  .refine((b) => b.kind === 'service' || !!b.dealId !== !!b.newDeal, { message: 'Нужна сделка: существующая или новая', path: ['dealId'] });

/** Заявка «выполняется» дольше — считаем зависшей (процесс упал), повтор разрешён. */
const STUCK_MS = 2 * 60_000;
/** Код пересечения броней в Битрикс24. */
const OVERLAP = '1018';

type Step = { step: string; at: string; ok: boolean; detail?: unknown };

/**
 * Создание брони — сага с журналом (`BookingOperation`) и компенсацией (ADR 0003, 0007):
 * 1) новая сделка (если нужна) → 2) бронь в Битрикс24 → 3) связь со сделкой и клиентом →
 * 4) системные поля сделки → 5) товары → 6) журнал броней. Сбой после шага 2 — бронь удаляется
 * (слот освобождается), созданная сделка остаётся (удалять сделки приложению нельзя) — это в ошибке.
 * Все вызовы — токеном сотрудника: его права в CRM, режим «только чтение» и песочница действуют.
 */
@Injectable()
export class BookingCreateService {
  private readonly logger = new Logger(BookingCreateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly journal: BookingJournalService,
    private readonly fieldMap: DealFieldMapService,
    private readonly dealForm: DealFormService,
    @Optional() private readonly actions?: ActionLogService,
    @Optional() private readonly stops?: ResourceStopsService,
  ) {}

  async create(user: B24UserContext, body: unknown): Promise<CreateBookingResultDto> {
    const parsed = createSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException({ code: 'INVALID_BOOKING', message: parsed.error.issues.map((i) => i.message).join('; ') });
    const b: CreateBookingDto = parsed.data;

    const a = await this.access.resolve(user);
    const g = this.access.pick(a, b.groupId, 'booking.create');
    if (!g) throw new ForbiddenException({ code: 'NO_BOOKING_CREATE', message: 'Нет права создавать брони в этой группе' });
    if (b.kind === 'client' && b.newDeal && !g.permissions.includes('deal.create'))
      throw new ForbiddenException({ code: 'NO_DEAL_CREATE', message: 'Нет права создавать сделки в этой группе' });
    if (b.kind === 'client' && !canUsePaymentMode(g.permissions, b.paymentMode))
      throw new ForbiddenException({
        code: 'PAYMENT_MODE_FORBIDDEN',
        message: `«${PAYMENT_MODE_LABELS[b.paymentMode]}» — только с правами создавать брони и сделки`,
      });
    // Тип брони — до любых записей в Битрикс24: выбор менеджера, иначе по товарам сделки (как БП 270).
    const options = (g.group.options ?? null) as GroupOptionsDto | null;
    const rules = options?.bookingTypes ?? [];
    let type: ReturnType<typeof detectBookingType> = null;
    if (b.kind === 'client') {
      if (b.bookingTypeId) {
        const rule = rules.find((r) => r.id === b.bookingTypeId);
        if (!rule) throw new BadRequestException({ code: 'UNKNOWN_BOOKING_TYPE', message: 'Такого типа брони нет в группе' });
        if (rule.unavailable) throw new BadRequestException({ code: 'BOOKING_TYPE_UNAVAILABLE', message: `«${rule.title}» сейчас недоступен для бронирования` });
        type = { rule, program: rule.program === PROGRAM_FROM_KEYWORD ? (detectBookingType([rule], await this.namesFor(user, b))?.program ?? '') : rule.program };
      } else type = detectBookingType(rules, await this.namesFor(user, b));
      if (!type && options?.bookingTypeRequired)
        throw new BadRequestException({
          code: 'BOOKING_TYPE_REQUIRED',
          message: 'Укажите тип брони: по товарам сделки он не определился (добавьте товары в сделку или выберите тип)',
        });
    }
    // Поля сделки группы (флаг «С») — проверка до записей; валюта денег — рубли (как в прототипе).
    let groupFields: Record<string, unknown> = {};
    let formFields: DealFormField[] = [];
    if (b.kind === 'client') {
      try {
        formFields = await this.dealForm.createFields(user, g);
        groupFields = dealUpdateFields(formFields, b.dealFields ?? {}, 'RUB', user.portal.timezone, true);
      } catch (e) {
        throw new BadRequestException({ code: 'INVALID_DEAL_FIELDS', message: msg(e) });
      }
    }
    const outside = b.resourceIds.filter((id) => !g.group.resourceIds.includes(id));
    if (outside.length) throw new BadRequestException({ code: 'RESOURCE_NOT_IN_GROUP', message: `Ресурсы не из группы: ${outside.join(', ')}` });
    // Стоп ресурса — бронь в этот период не создаётся.
    await this.stops?.assertOpen(user.portal.id, b.resourceIds, new Date(b.start), new Date(b.end), user.portal.timezone);

    // Идемпотентность: повтор заявки возвращает прежний результат.
    const prev = await this.prisma.bookingOperation.findUnique({
      where: { portalId_idempotencyKey: { portalId: user.portal.id, idempotencyKey: b.idempotencyKey } },
    });
    if (prev?.status === 'done' && prev.bookingId)
      return { bookingId: prev.bookingId, dealId: prev.dealId, bookingType: null, warnings: ['Повтор заявки: бронь уже создана'] };
    // Идёт прямо сейчас (не зависла дольше 2 минут) — второй раз не запускаем.
    if (prev?.status === 'running' && prev.updatedAt.getTime() > Date.now() - STUCK_MS)
      throw new ConflictException({ code: 'OPERATION_RUNNING', message: 'Бронь уже создаётся — дождитесь результата' });
    // Прошлая попытка сорвалась — повтор безопасен: созданная тогда новая сделка используется снова,
    // а бронь, которую не удалось снять откатом, сначала снимаем.
    const reuseDealId = prev && b.newDeal ? prev.dealId : null;
    if (prev?.bookingId) {
      try {
        await user.client.call('booking.v1.booking.delete', { id: prev.bookingId });
      } catch (err) {
        if (!(err instanceof Bitrix24Error && String(err.code) === '1021'))
          throw new ServiceUnavailableException({ code: 'BITRIX_UNAVAILABLE', message: `Бронь не создана: не удалось убрать бронь #${prev.bookingId} прошлой попытки — повторите через минуту` });
      }
    }
    const op = prev
      ? await this.prisma.bookingOperation.update({ where: { id: prev.id }, data: { status: 'running', error: null, bookingId: null, steps: [] } })
      : await this.prisma.bookingOperation.create({
          data: {
            portalId: user.portal.id,
            idempotencyKey: b.idempotencyKey,
            userId: user.userId,
            status: 'running',
            steps: [],
            request: b as unknown as Prisma.InputJsonValue,
          },
        });
    const steps: Step[] = [];
    const log = async (step: string, ok: boolean, detail?: unknown) => {
      steps.push({ step, at: new Date().toISOString(), ok, ...(detail === undefined ? {} : { detail }) });
      await this.prisma.bookingOperation.update({ where: { id: op.id }, data: { steps: steps as unknown as Prisma.InputJsonValue } });
    };

    const tz = user.portal.timezone;
    const warnings: string[] = [];
    let dealId = b.dealId ?? null;
    let createdDeal = false;
    let bookingId: number | null = null;
    try {
      // 1. Сделка
      if (b.kind === 'client' && b.newDeal && reuseDealId) {
        dealId = reuseDealId;
        createdDeal = true;
        await log('deal.reused', true, { dealId });
      } else if (b.kind === 'client' && b.newDeal) {
        const res = await user.client.call<number>('crm.deal.add', {
          fields: {
            TITLE: b.newDeal.title,
            CATEGORY_ID: g.group.dealCategoryId ?? 0,
            ASSIGNED_BY_ID: user.userId,
            ...(b.newDeal.contactId ? { CONTACT_ID: b.newDeal.contactId } : {}),
          },
        });
        dealId = Number(res.result);
        createdDeal = true;
        await log('deal.add', true, { dealId });
      }
      const contactId = b.contactId ?? b.newDeal?.contactId ?? null;

      // 2. Бронь
      const products = b.products ?? [];
      const name = b.kind === 'service' ? `Служебная: ${b.comment?.slice(0, 80) || 'блокировка'}` : b.newDeal?.title ?? `Сделка #${dealId}`;
      try {
        const res = await user.client.call<number | { id?: number }>('booking.v1.booking.add', {
          fields: {
            resourceIds: b.resourceIds,
            name,
            description: b.comment ?? '',
            datePeriod: {
              from: { timestamp: Math.floor(Date.parse(b.start) / 1000), timezone: tz },
              to: { timestamp: Math.floor(Date.parse(b.end) / 1000), timezone: tz },
            },
          },
        });
        bookingId = typeof res.result === 'object' && res.result !== null ? Number(res.result.id) : Number(res.result);
      } catch (err) {
        if (err instanceof Bitrix24Error && String(err.code) === OVERLAP)
          throw new ConflictException({ code: 'BOOKING_OVERLAP', message: 'Время уже занято другой бронью этого ресурса' });
        throw err;
      }
      await log('booking.add', true, { bookingId });

      // 3. Связи: сделка и клиент
      if (dealId) {
        await user.client.call('booking.v1.booking.externalData.set', {
          bookingId,
          externalData: [{ moduleId: 'crm', entityTypeId: 'DEAL', value: String(dealId) }],
        });
        await log('externalData.set', true);
      }
      if (contactId) {
        try {
          await user.client.call('booking.v1.booking.client.set', {
            bookingId,
            clients: [{ id: contactId, type: { module: 'crm', code: 'CONTACT' } }],
          });
          await log('client.set', true);
        } catch (err) {
          // Клиент брони — для удобства в интерфейсе Битрикс24; бронь без него рабочая.
          warnings.push('Клиент не привязан к брони в Битрикс24');
          await log('client.set', false, msg(err));
        }
      }

      // 4. Системные поля сделки
      if (dealId) {
        const map = await this.fieldMap.get(user.portal.id);
        const typeValue =
          type?.rule.dealTypeValue && map.bookingType ? await this.fieldMap.enumId(user.portal.id, user.client, map.bookingType, type.rule.dealTypeValue) : null;
        if (type && type.rule.dealTypeValue && map.bookingType && !typeValue) warnings.push(`Тип «${type.rule.title}»: значение не найдено в поле «Тип бронирования» — поле не заполнено`);
        // «Тип сделки» по выбору в мастере — вариант списка по началу названия.
        const kindFields: Record<string, string> = {};
        if (b.prepaymentAmount) {
          const code = (await this.fieldMap.resolved(user.portal.id, user.client)).prepaymentAmount;
          if (code) kindFields[code] = `${b.prepaymentAmount}|RUB`;
          else warnings.push('Поле «Сумма предоплаты» не найдено — сумма ссылки только в окне оплаты');
        }
        if (b.dealKind) {
          const code = (await this.fieldMap.resolved(user.portal.id, user.client)).dealType;
          const value = code ? await this.fieldMap.enumId(user.portal.id, user.client, code, DEAL_KIND_TYPE_VALUE[b.dealKind], true).catch(() => null) : null;
          if (code && value) kindFields[code] = value;
          else warnings.push(`«${DEAL_KIND_LABELS[b.dealKind]}»: поле «Тип сделки» не заполнено (нет поля или такого варианта)`);
        }
        // Системные поля важнее полей формы: их значения приложение считает само.
        const fields = { ...groupFields, ...kindFields, ...(await this.systemFields(user.portal.id, b, bookingId, tz, typeValue ?? '')) };
        if (Object.keys(fields).length) {
          if (await this.dealWrite(() => user.client.call('crm.deal.update', { id: dealId, fields }), createdDeal, log, 'deal.update')) {
            await log('deal.update', true, { fields: Object.keys(fields) });
            // Поля, которые заполнил менеджер в форме брони, — в журнал действий («стало»).
            const changes = formFields
              .filter((f) => f.code in (b.dealFields ?? {}) && (b.dealFields?.[f.code] ?? '') !== '')
              .map((f) => ({ field: f.code, label: f.label, before: null, after: b.dealFields?.[f.code] ?? null }));
            if (changes.length)
              await this.actions?.user(user, {
                action: 'deal.update',
                summary: `Заполнил поля сделки #${dealId} при создании брони: ${changes.map((c) => c.label).join(', ')}`,
                entityType: 'deal',
                entityId: dealId,
                details: { bookingId, changes },
              });
          } else warnings.push(`Поля сделки #${dealId} не заполнены: изменять существующие сделки не разрешено (⚙ → «Приложение» → «Запись в Битрикс24»)`);
        } else warnings.push('Системные поля сделки не настроены (⚙ → «Приложение»)');
      }

      // 5. Товары (полная замена строк сделки)
      if (dealId && products.length) {
        const rows = products.map(productRow);
        if (await this.dealWrite(() => user.client.call('crm.deal.productrows.set', { id: dealId, rows }), createdDeal, log, 'productrows.set'))
          await log('productrows.set', true, { count: products.length });
        else warnings.push(`Товары сделки #${dealId} не записаны: изменять существующие сделки приложению пока не разрешено`);
      }
      if (b.kind === 'client' && products.length && !type) warnings.push('Тип брони по товарам не определён — подтверждение клиенту не уйдёт');

      // 6. Журнал броней приложения
      await this.journal.recordCreated(
        user.portal.id,
        {
          bookingId,
          kind: b.kind,
          dealId: b.kind === 'client' ? dealId : null,
          groupId: g.group.id,
          resourceIds: b.resourceIds,
          startsAt: new Date(b.start),
          endsAt: new Date(b.end),
          title: name,
          paymentMode: b.kind === 'client' ? b.paymentMode : null,
        },
        { kind: 'user', userId: user.userId, name: user.userName },
      );
      await this.prisma.bookingOperation.update({ where: { id: op.id }, data: { status: 'done', bookingId, dealId } });
      return { bookingId, dealId, bookingType: type?.rule.title ?? null, warnings };
    } catch (err) {
      // Компенсация: снять бронь — слот свободен; созданную сделку не удаляем (сообщаем).
      let leftBooking: number | null = null;
      if (bookingId) {
        try {
          await user.client.call('booking.v1.booking.delete', { id: bookingId });
          await log('compensate.booking.delete', true, { bookingId });
        } catch (e) {
          this.logger.error(`booking ${bookingId}: compensation failed: ${msg(e)}`);
          await log('compensate.booking.delete', false, msg(e));
          // Повтор заявки сначала снимет её.
          leftBooking = bookingId;
        }
      }
      const text = `${msg(err)}${createdDeal ? ` (создана сделка #${dealId} — повтор использует её)` : ''}`.slice(0, 1000);
      await this.prisma.bookingOperation.update({ where: { id: op.id }, data: { status: 'failed', error: text, dealId, bookingId: leftBooking } });
      // Портал не ответил (лимит, сеть, сбой) — понятная ошибка «повторите»: повтор той же заявки безопасен.
      if (err instanceof Bitrix24Error && TRANSIENT_CODES.has(String(err.code)))
        throw new ServiceUnavailableException({
          code: 'BITRIX_UNAVAILABLE',
          message: `Бронь не создана: Битрикс24 сейчас не ответил. Повторите через минуту — ничего не задвоится${createdDeal ? ` (сделка #${dealId} уже создана и будет использована)` : ''}.`,
        });
      throw err;
    }
  }

  /**
   * Запись в сделку. Существующую сделку режим «только чтение» может не пускать (разрешено только
   * создавать новые) — тогда бронь остаётся, а сотрудник видит предупреждение. Новую сделку
   * приложение создало само, поэтому отказ записи в неё — настоящая ошибка (компенсация).
   */
  private async dealWrite(write: () => Promise<unknown>, createdDeal: boolean, log: (step: string, ok: boolean, detail?: unknown) => Promise<void>, step: string): Promise<boolean> {
    try {
      await write();
      return true;
    } catch (err) {
      if (createdDeal || !(err instanceof Bitrix24Error) || err.code !== 'READ_ONLY_MODE') throw err;
      await log(step, false, msg(err));
      return false;
    }
  }

  /** Названия товаров: из заявки, иначе — товары существующей сделки (менеджер ведёт их в сделке). */
  private async namesFor(user: B24UserContext, b: CreateBookingDto): Promise<string[]> {
    if (b.products?.length) return this.productNames(user, b.products.map((p) => p.productId));
    if (!b.dealId) return [];
    try {
      const rows = (await user.client.call<{ PRODUCT_NAME?: string }[]>('crm.deal.productrows.get', { id: b.dealId })).result ?? [];
      return rows.map((r) => r.PRODUCT_NAME ?? '').filter(Boolean);
    } catch {
      return [];
    }
  }

  private async productNames(user: B24UserContext, ids: number[]): Promise<string[]> {
    const rows = await user.client.listAll<{ NAME?: string }>('crm.product.list', { filter: { ID: ids }, select: ['ID', 'NAME'] });
    return rows.map((r) => r.NAME ?? '').filter(Boolean);
  }

  /** Поля сделки по настройке портала: ID брони, даты брони и визита, гости, тип, комментарий. */
  private async systemFields(portalId: string, b: CreateBookingDto, bookingId: number, tz: string, typeValue: string) {
    const m = await this.fieldMap.get(portalId);
    const f: Record<string, unknown> = {};
    const put = (code: string | undefined, v: unknown) => {
      if (code && v !== undefined && v !== null && v !== '') f[code] = v;
    };
    put(m.bookingId, String(bookingId));
    Object.assign(f, dealDateFields(m, new Date(b.start), new Date(b.end), tz));
    put(m.guests, b.guests);
    put(m.bookingType, typeValue);
    put(m.managerComment, b.comment);
    return f;
  }
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Даты брони и визита в системных полях сделки (те, что настроены на портале). */
export function dealDateFields(m: DealFieldMapDto, s: Date, e: Date, tz: string): Record<string, string> {
  const f: Record<string, string> = {};
  const put = (code: string | undefined, v: string) => {
    if (code) f[code] = v;
  };
  put(m.bookingStart, zonedIso(s, tz));
  put(m.bookingEnd, zonedIso(e, tz));
  put(m.visitDateStart, dateRu(s, tz));
  put(m.visitTimeStart, timeRu(s, tz));
  put(m.visitDateEnd, dateRu(e, tz));
  put(m.visitTimeEnd, timeRu(e, tz));
  return f;
}

export function dateRu(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('ru-RU', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
}
export function timeRu(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('ru-RU', { timeZone, hour: '2-digit', minute: '2-digit' }).format(d);
}
/** «2026-10-23T14:00:00+03:00» — время в поясе портала со смещением (для полей «дата/время»). */
export function zonedIso(d: Date, timeZone: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const off = Math.round((local - d.getTime()) / 60000);
  const sign = off >= 0 ? '+' : '-';
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
  const mm = String(Math.abs(off) % 60).padStart(2, '0');
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sign}${hh}:${mm}`;
}

/**
 * Строка товара для `crm.deal.productrows.set`: итоговая цена за единицу и скидка — процентом
 * (`DISCOUNT_TYPE_ID = 2`) или суммой на единицу (`1`), как хранит Битрикс24.
 */
export function productRow(p: BookingProductInput) {
  const final = discountedPrice(p);
  const perUnit = Math.round((p.price - final) * 100) / 100;
  return {
    PRODUCT_ID: p.productId,
    QUANTITY: p.quantity,
    PRICE: final,
    DISCOUNT_TYPE_ID: p.discountType === 'sum' ? 1 : 2,
    DISCOUNT_RATE: p.discountType === 'sum' ? (p.price ? Math.round((perUnit / p.price) * 10000) / 100 : 0) : Math.min(p.discount ?? 0, 100),
    DISCOUNT_SUM: perUnit,
  };
}
