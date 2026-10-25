import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, NotFoundException, Param, ParseIntPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import type {
  ResourceStopCheckDto,
  ResourceStopDto,
  BookingAlertDto,
  BookingVersionsDto,
  BookingCatalogDto,
  CrmSearchDto,
  DealProductRowDto,
  RecentDealsDto,
  BookingAlertListDto,
  BookingInfoDto,
  GroupOptionsDto,
  BookingHistoryDto,
  BookingStateDto,
  CancelBookingResultDto,
  BookingSyncSettingsDto,
  ClientBookingsDto,
  CreateBookingResultDto,
  DealFieldMapDto,
  DealFormDto,
  DealOverviewDto,
  NewDealResultDto,
  Permission,
} from '@btx24/shared';
import { z } from 'zod';
import { SwrCache, type SwrOptions } from '../../common/swr-cache.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AccessService } from '../access/access.service.js';
import { AppAdminGuard } from '../access/app-admin.guard.js';
import { B24AuthGuard, B24User } from '../bitrix24/auth/b24-auth.guard.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { BookingAlertsService } from './booking-alerts.service.js';
import { BookingRestoreService } from './booking-restore.service.js';
import { BookingCancelService } from './booking-cancel.service.js';
import { BookingDirectoryService } from './booking-directory.service.js';
import { BookingInfoService } from './booking-info.service.js';
import { BookingCreateService } from './booking-create.service.js';
import { BookingJournalService } from './booking-journal.service.js';
import { ClientBookingsService } from './client-bookings.service.js';
import { DealFieldMapService } from './deal-field-map.service.js';
import { DealFormService } from './deal-form.service.js';
import { DealHubService } from './deal-hub.service.js';
import { ResourceStopsService } from './resource-stops.service.js';

/**
 * Брони клиента чата и сделки: панель чата и встройка сделки перечитывают их при каждом открытии и опросе.
 * Кэш сбрасывается любым изменением броней/сделок портала (и событиями Битрикс24).
 */
const clientBookingsCache = new SwrCache<ClientBookingsDto>();
const CLIENT_BOOKINGS_SWR: SwrOptions = { freshMs: 20_000, staleMs: 2 * 60_000 };

/**
 * Уведомления о бронях и история броней. Видеть — право `booking.details` хотя бы в одной группе;
 * менять статус и принимать — `booking.edit`; отменять — `booking.cancel` (или администратор приложения).
 */
@Controller()
@UseGuards(B24AuthGuard)
export class BookingsController {
  constructor(
    private readonly access: AccessService,
    private readonly alerts: BookingAlertsService,
    private readonly journal: BookingJournalService,
    private readonly creator: BookingCreateService,
    private readonly clients: ClientBookingsService,
    private readonly dealForm: DealFormService,
    private readonly canceller: BookingCancelService,
    private readonly directory: BookingDirectoryService,
    private readonly restore: BookingRestoreService,
    private readonly stops: ResourceStopsService,
    private readonly hub: DealHubService,
    private readonly bookingInfo: BookingInfoService,
  ) {}

  /** Действующие и будущие стопы ресурсов моих групп (блок дашборда). */
  @Get('resource-stops')
  stopsUpcoming(@B24User() user: B24UserContext, @Query() query: Record<string, unknown> = {}): Promise<(ResourceStopDto & { resourceName: string })[]> {
    return this.stops.upcoming(user, query);
  }

  /** Стоп ресурса: брони и стопы в периоде — перед установкой. */
  @Post('resource-stops/check')
  @HttpCode(200)
  stopCheck(@B24User() user: B24UserContext, @Body() body: unknown): Promise<ResourceStopCheckDto> {
    return this.stops.check(user, body);
  }

  /** Поставить стоп (броней в периоде нет — иначе 409 с их списком). */
  @Post('resource-stops')
  stopCreate(@B24User() user: B24UserContext, @Body() body: unknown): Promise<ResourceStopDto> {
    return this.stops.create(user, body);
  }

  @Delete('resource-stops/:id')
  @HttpCode(204)
  stopLift(@B24User() user: B24UserContext, @Param('id') id: string): Promise<void> {
    return this.stops.lift(user, id);
  }

  /** Товары группы для формы брони (разделы каталога из настроек группы) и товары по умолчанию. */
  @Get('booking-catalog')
  catalog(@B24User() user: B24UserContext, @Query('groupId') groupId?: string): Promise<BookingCatalogDto> {
    if (!groupId) throw new BadRequestException({ code: 'GROUP_REQUIRED', message: 'Укажите группу' });
    return this.directory.catalog(user, groupId);
  }

  /** Товары сделки — форма брони показывает их (строки заменяются целиком). */
  @Get('deals/:dealId/products')
  dealProducts(@B24User() user: B24UserContext, @Param('dealId', ParseIntPipe) dealId: number): Promise<DealProductRowDto[]> {
    return this.directory.dealProducts(user, dealId);
  }

  /** Мастер брони, шаг 1: 20 открытых сделок с последней активностью. */
  @Get('crm/recent-deals')
  async recentDeals(@B24User() user: B24UserContext): Promise<RecentDealsDto> {
    return { deals: await this.directory.recentDeals(user) };
  }

  /** Поиск клиента или сделки для брони: от 2 символов; `contactId` — сделки выбранного клиента. */
  @Get('crm/search')
  search(@B24User() user: B24UserContext, @Query() query: Record<string, unknown>): Promise<CrmSearchDto> {
    return this.directory.search(user, query);
  }

  @Get('booking-alerts')
  async list(@B24User() user: B24UserContext, @Query('status') status?: string, @Query() query: Record<string, unknown> = {}): Promise<BookingAlertListDto> {
    await this.require(user, 'booking.details');
    return this.alerts.list(user.portal, status, query);
  }

  @Put('booking-alerts/:id')
  async status(@B24User() user: B24UserContext, @Param('id') id: string, @Body() body: unknown): Promise<BookingAlertDto> {
    await this.require(user, 'booking.edit');
    return this.alerts.setStatus(user, id, body);
  }

  @Post('booking-alerts/:id/resolve')
  async resolve(@B24User() user: B24UserContext, @Param('id') id: string, @Body() body: unknown): Promise<BookingAlertDto> {
    const resolution = (body as { resolution?: unknown } | null)?.resolution;
    await this.require(user, resolution === 'cancel_booking' ? 'booking.cancel' : resolution === 'recreate' ? 'booking.create' : 'booking.edit');
    // Право в группе ресурса брони для «откатить», «создать заново», «удалить в приложении» — в сервисе.
    return this.alerts.resolve(user, id, body);
  }

  /** Версии данных брони (снимки из истории) — для «Откатить» и «Истории изменений», по 3. */
  @Get('bookings/:bookingId/versions')
  async versions(
    @B24User() user: B24UserContext,
    @Param('bookingId', ParseIntPipe) bookingId: number,
    @Query('offset') offset?: string,
    @Query('limit') limit?: string,
  ): Promise<BookingVersionsDto> {
    await this.require(user, 'booking.details');
    return this.restore.versions(user, bookingId, Number(offset) || 0, Number(limit) || 3);
  }

  /** Бронь приложения пропала в Битрикс24 — создать там заново по данным журнала (право в группе ресурса — в сервисе). */
  @Post('bookings/:bookingId/recreate')
  @HttpCode(204)
  async recreate(@B24User() user: B24UserContext, @Param('bookingId', ParseIntPipe) bookingId: number): Promise<void> {
    await this.alerts.resolveMissing(user, bookingId, 'recreate');
  }

  /** Бронь приложения пропала в Битрикс24 — согласиться: отменить в приложении (право в группе ресурса — в сервисе). */
  @Post('bookings/:bookingId/remove-in-app')
  @HttpCode(204)
  async removeInApp(@B24User() user: B24UserContext, @Param('bookingId', ParseIntPipe) bookingId: number): Promise<void> {
    await this.alerts.resolveMissing(user, bookingId, 'accept_bitrix');
  }

  /** Создать бронь (сага). Право `booking.create` в группе проверяет сервис. */
  @Post('bookings')
  create(@B24User() user: B24UserContext, @Body() body: unknown): Promise<CreateBookingResultDto> {
    return this.creator.create(user, body);
  }

  /** Снять бронь: удалить в Битрикс24 и отменить в журнале (`booking.cancel` в группе — проверяет сервис). */
  @Post('bookings/:bookingId/cancel')
  cancel(@B24User() user: B24UserContext, @Param('bookingId', ParseIntPipe) bookingId: number, @Body() body: unknown): Promise<CancelBookingResultDto> {
    return this.canceller.cancel(user, bookingId, body);
  }

  /** Поля сделки группы для формы брони и карточки (значения — если указана сделка). Права проверяет сервис. */
  @Get('deal-form')
  form(
    @B24User() user: B24UserContext,
    @Query('groupId') groupId?: string,
    @Query('dealId') dealId?: string,
    @Query('purpose') purpose?: string,
  ): Promise<DealFormDto> {
    if (!groupId) throw new BadRequestException({ code: 'GROUP_REQUIRED', message: 'Укажите группу' });
    const id = dealId ? Number(dealId) : null;
    if (id !== null && !(Number.isSafeInteger(id) && id > 0)) throw new BadRequestException({ code: 'INVALID_DEAL', message: 'Неверный ID сделки' });
    // purpose=edit — карточка брони «Редактировать»: открытие правки пишется в журнал действий.
    return this.dealForm.form(user, groupId, id, purpose === 'edit' ? 'edit' : 'create');
  }

  /** Правка полей сделки из карточки брони (`booking.edit` в группе). */
  @Put('deals/:dealId/fields')
  updateDealFields(@B24User() user: B24UserContext, @Param('dealId', ParseIntPipe) dealId: number, @Body() body: unknown): Promise<DealFormDto> {
    return this.dealForm.update(user, dealId, body);
  }

  /** Брони сделки и её клиента — встройка в карточку сделки, дата календаря. */
  @Get('deals/:dealId/bookings')
  async dealBookings(@B24User() user: B24UserContext, @Param('dealId', ParseIntPipe) dealId: number): Promise<ClientBookingsDto> {
    await this.require(user, 'calendar.view');
    return this.clientBookings(user, `deal:${dealId}`, () => this.clients.forDeal(user, dealId));
  }

  /**
   * Карточка брони с дашборда: право `booking.details` в группе, где есть ресурс брони (администратор —
   * любая); поля сделки — по настройке этой группы.
   */
  @Get('bookings/:bookingId/info')
  async bookingInfoCard(@B24User() user: B24UserContext, @Param('bookingId', ParseIntPipe) bookingId: number): Promise<BookingInfoDto> {
    const record = await this.journal.findAny(user.portal.id, bookingId);
    if (!record) throw new NotFoundException({ code: 'BOOKING_NOT_FOUND', message: `Бронь #${bookingId} не найдена` });
    const a = await this.access.resolve(user);
    const resources = (record.resourceIds as number[]).map(Number);
    const group = a.groups.find((g) => g.permissions.includes('booking.details') && g.group.resourceIds.some((id) => resources.includes(id)));
    if (!group && !a.isAppAdmin) throw new ForbiddenException({ code: 'NO_BOOKING_ACCESS', message: 'Нет доступа к данным этой брони' });
    const fields = (group?.group.options as GroupOptionsDto | null)?.dealFields ?? [];
    return this.bookingInfo.info(user, record.bookingId, fields);
  }

  /** Встройка сделки, «Сделка»: карточка и таймлайн действий сотрудников (правами сотрудника в CRM). */
  @Get('deals/:dealId/overview')
  async dealOverview(@B24User() user: B24UserContext, @Param('dealId', ParseIntPipe) dealId: number): Promise<DealOverviewDto> {
    await this.require(user, 'calendar.view');
    return this.hub.overview(user, dealId);
  }

  /** Встройка сделки: по сделке уже есть бронь — новая сделка с тем же клиентом. */
  @Post('deals/:dealId/new-deal')
  async newDeal(@B24User() user: B24UserContext, @Param('dealId', ParseIntPipe) dealId: number): Promise<NewDealResultDto> {
    await this.require(user, 'booking.create');
    return this.hub.newDeal(user, dealId);
  }

  /** Брони клиента чата открытой линии. */
  @Get('openlines/chats/:chatId/bookings')
  async chatBookings(@B24User() user: B24UserContext, @Param('chatId', ParseIntPipe) chatId: number): Promise<ClientBookingsDto> {
    await this.require(user, 'openlines.read');
    return this.clientBookings(user, `chat:${chatId}`, () => this.clients.forChat(user, chatId));
  }

  /** История брони (аудит): кто, что, как и когда. */
  @Get('bookings/:bookingId/history')
  async history(
    @B24User() user: B24UserContext,
    @Param('bookingId', ParseIntPipe) bookingId: number,
  ): Promise<BookingHistoryDto> {
    await this.require(user, 'booking.details');
    const h = await this.journal.historyOf(user.portal.id, bookingId);
    if (!h) throw new NotFoundException({ code: 'BOOKING_NOT_FOUND', message: 'Бронь не найдена в журнале приложения' });
    return {
      bookingId,
      source: h.record.source,
      status: h.record.status,
      entries: h.rows.map((r) => ({
        at: r.at.toISOString(),
        action: r.action,
        actorKind: r.actorKind,
        actorName: r.actorName,
        via: r.via,
        before: (r.before as BookingStateDto | null) ?? null,
        after: (r.after as BookingStateDto | null) ?? null,
        details: r.details ?? null,
      })),
    };
  }

  /** Ответ — свой у каждого сотрудника (права в CRM), права приложения проверены до кэша. */
  private async clientBookings(user: B24UserContext, key: string, compute: () => Promise<ClientBookingsDto>): Promise<ClientBookingsDto> {
    const { value } = await clientBookingsCache.get(JSON.stringify([user.portal.id, user.userId, key]), compute, { ...CLIENT_BOOKINGS_SWR, scope: user.portal.memberId, tags: ['bookings', 'deals'] });
    return value;
  }

  private async require(user: B24UserContext, permission: Permission): Promise<void> {
    const a = await this.access.resolve(user);
    if (a.isAppAdmin || this.access.pick(a, undefined, permission) !== null) return;
    throw new ForbiddenException({ code: 'NO_BOOKING_ACCESS', message: 'Недостаточно прав для действий с бронями' });
  }
}

const syncSettingsSchema = z.object({ syncHorizonDays: z.number().int().min(7).max(730) }).strict();

/** Сверка с Битрикс24 и чат уведомлений — только администраторы приложения. */
@Controller('admin/booking-sync')
@UseGuards(B24AuthGuard, AppAdminGuard)
export class BookingSyncAdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fieldMap: DealFieldMapService,
  ) {}

  /** Системные поля сделки: роль → код поля. */
  @Get('deal-fields')
  dealFields(@B24User() user: B24UserContext): Promise<DealFieldMapDto> {
    return this.fieldMap.get(user.portal.id);
  }

  @Put('deal-fields')
  saveDealFields(@B24User() user: B24UserContext, @Body() body: unknown): Promise<DealFieldMapDto> {
    return this.fieldMap.save(user.portal.id, user.userId, body);
  }

  /** Найти поля по названиям — без сохранения. */
  @Get('deal-fields/detect')
  detectDealFields(@B24User() user: B24UserContext): Promise<DealFieldMapDto> {
    return this.fieldMap.detect(user);
  }

  @Get()
  async get(@B24User() user: B24UserContext): Promise<BookingSyncSettingsDto> {
    return this.dto(user.portal.id);
  }

  @Put()
  async save(@B24User() user: B24UserContext, @Body() body: unknown): Promise<BookingSyncSettingsDto> {
    const parsed = syncSettingsSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException({ code: 'INVALID_SETTINGS', message: 'Горизонт сверки — от 7 до 730 дней' });
    await this.prisma.portalSettings.upsert({
      where: { portalId: user.portal.id },
      create: { portalId: user.portal.id, ...parsed.data, updatedByUserId: user.userId },
      update: { ...parsed.data, updatedByUserId: user.userId },
    });
    return this.dto(user.portal.id);
  }

  /**
   * Создать чат уведомлений (один раз): участники — администратор, нажавший кнопку, и
   * администраторы приложения (сотрудники). Создаёт его токеном — он владелец чата.
   */
  @Post('chat')
  async createChat(@B24User() user: B24UserContext): Promise<BookingSyncSettingsDto> {
    const current = await this.prisma.portalSettings.findUnique({ where: { portalId: user.portal.id } });
    if (current?.alertChatId) return this.dto(user.portal.id);
    const admins = await this.prisma.appAdmin.findMany({ where: { portalId: user.portal.id, kind: 'USER' } });
    const res = await user.client.call<number>('im.chat.add', {
      TYPE: 'CHAT',
      TITLE: 'Брони: уведомления',
      DESCRIPTION:
        'Приложение бронирования пишет сюда о новых бронях, созданных мимо приложения, и о расхождениях с Битрикс24. ' +
        'Статус каждого уведомления меняется в приложении.',
      COLOR: 'AZURE',
      USERS: [...new Set([user.userId, ...admins.map((a) => a.bitrixId)])],
      MESSAGE: 'Чат уведомлений о бронях создан. Здесь появятся новые бронирования и расхождения данных.',
    });
    const chatId = Number(res.result);
    if (!Number.isInteger(chatId) || chatId <= 0)
      throw new BadRequestException({ code: 'CHAT_NOT_CREATED', message: 'Битрикс24 не вернул ID чата' });
    await this.prisma.portalSettings.upsert({
      where: { portalId: user.portal.id },
      create: { portalId: user.portal.id, alertChatId: chatId, updatedByUserId: user.userId },
      update: { alertChatId: chatId, updatedByUserId: user.userId },
    });
    return this.dto(user.portal.id);
  }

  private async dto(portalId: string): Promise<BookingSyncSettingsDto> {
    const s = await this.prisma.portalSettings.findUnique({ where: { portalId } });
    return {
      alertChatId: s?.alertChatId ?? null,
      syncHorizonDays: s?.syncHorizonDays ?? 180,
      baselineAt: s?.bookingSyncBaselineAt?.toISOString() ?? null,
      lastSyncAt: s?.bookingSyncAt?.toISOString() ?? null,
      lastSyncError: s?.bookingSyncError ?? null,
    };
  }
}
