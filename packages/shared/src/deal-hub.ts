import type { ChatSummary } from './openlines.js';

/**
 * Встройка сделки: стартовый экран «Чат · Сделка · Календарь». `GET /api/deals/:id/overview` — карточка
 * сделки и таймлайн действий сотрудников (CRM: создание, стадии, дела, комментарии; приложение: журнал
 * действий по сделке и её броням). Читается токеном сотрудника — действуют его права в CRM.
 */
export type DealTimelineKind = 'created' | 'stage' | 'call' | 'chat' | 'email' | 'meeting' | 'task' | 'activity' | 'comment' | 'app';

export interface DealTimelineItemDto {
  /** Уникален в пределах ответа: `stage:12`, `activity:345`, `comment:6`, `app:<cuid>`. */
  id: string;
  at: string;
  kind: DealTimelineKind;
  /** Сотрудник; null — система (робот, синхронизация) или автор неизвестен. */
  actor: { id: number | null; name: string } | null;
  title: string;
  text: string | null;
  /** Для дел: входящее/исходящее. */
  direction?: 'in' | 'out' | null;
}

export interface DealOverviewDto {
  deal: {
    id: number;
    title: string;
    stage: { id: string; name: string; semantics: 'P' | 'S' | 'F' | null } | null;
    opportunity: number | null;
    currency: string | null;
    assigned: { id: number; name: string } | null;
    createdAt: string | null;
  };
  contact: { id: number; name: string | null; phones: string[] } | null;
  /** Новые сверху. */
  timeline: DealTimelineItemDto[];
}

/** `POST /api/deals/:id/new-deal` — новая сделка с тем же клиентом (воронка и компания — как у исходной). */
export interface NewDealResultDto {
  id: number;
}

/** `GET /api/openlines/deal-chats/:dealId` — чаты открытых линий сделки и её клиента (вкладка с именем клиента). */
export interface DealChatsDto {
  clientName: string | null;
  items: ChatSummary[];
}

/**
 * Блоки дашборда «Ближайшие брони» и «Текущие брони»: `GET /api/dashboard/live-bookings?kind=upcoming|current`.
 * Брони — журнал приложения по ресурсам групп сотрудника; сделки и клиенты — копия CRM с проверкой прав.
 */
export type LiveBookingsKind = 'upcoming' | 'current';

export interface LiveBookingDto {
  bookingId: number;
  dealId: number | null;
  /** Название сделки (или брони, если сделки нет/она недоступна). */
  title: string;
  start: string;
  end: string;
  resources: string[];
  resourceIds: number[];
  client: { id: number; name: string; photo: string | null } | null;
  /** Сумма сделки. */
  amount: number | null;
  currency: string | null;
  /** «Сумма внесённых оплат» сделки; null — поле не настроено/неизвестно. */
  paid: number | null;
  /** Бронь пропала в Битрикс24 и ждёт решения. */
  pendingRemoval: boolean;
}

export interface LiveBookingsDto {
  kind: LiveBookingsKind;
  items: LiveBookingDto[];
}

/** `GET /api/bookings/:bookingId/info` — карточка брони с дашборда: бронь, сделка, клиент, поля группы, товары. */
export interface BookingInfoDto {
  booking: { id: number; title: string | null; start: string; end: string; resources: string[]; status: 'active' | 'cancelled'; source: 'app' | 'bitrix' };
  deal: {
    id: number;
    title: string;
    stage: string | null;
    amount: number | null;
    currency: string | null;
    paid: number | null;
    assigned: string | null;
  } | null;
  client: { id: number; name: string; photo: string | null; phones: string[] } | null;
  /** Поля сделки по настройке группы ресурса (как в карточке брони календаря). */
  fields: { code: string; label: string; value: string }[];
  products: { name: string; quantity: number; price: number; sum: number }[];
}
