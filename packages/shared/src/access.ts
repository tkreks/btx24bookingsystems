import type { AutoMessageRule } from './auto-messages.js';
// Роли и права в группах (ADR 0005). Источник правды и для api (проверка), и для web (скрытие
// недоступного). Право в группе = права роли ∩ функции, включённые в группе.

import type { BookingTypeRule } from './client-messages.js';

export const PERMISSIONS = [
  'calendar.view', // видеть календарь ресурсов группы
  'booking.details', // видеть данные броней и сделок (без него — только занятость/тех. окна)
  'booking.create',
  'deal.create', // новые сделки из формы брони; вместе с booking.create — «Бесплатно» и «Без предоплаты»
  'booking.edit',
  'booking.cancel',
  'payment.send', // ссылки на предоплату/доплату
  'openlines.read',
  'openlines.send',
  'group.manage', // настройки своей группы
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = ['VIEWER', 'TECHNOLOGIST', 'MANAGER', 'GROUP_ADMIN'] as const;
export type GroupRole = (typeof ROLES)[number];

/** Порядок старшинства: из ролей отделов берётся старшая (личная роль важнее отделов). */
export const ROLE_RANK: Record<GroupRole, number> = { TECHNOLOGIST: 0, VIEWER: 1, MANAGER: 2, GROUP_ADMIN: 3 };

export const ROLE_PERMISSIONS: Record<GroupRole, readonly Permission[]> = {
  TECHNOLOGIST: ['calendar.view'],
  VIEWER: ['calendar.view', 'booking.details', 'openlines.read'],
  MANAGER: [
    'calendar.view',
    'booking.details',
    'booking.create',
    'deal.create',
    'booking.edit',
    'booking.cancel',
    'payment.send',
    'openlines.read',
    'openlines.send',
  ],
  GROUP_ADMIN: PERMISSIONS,
};

export const ROLE_LABELS: Record<GroupRole, string> = {
  VIEWER: 'Просмотр',
  TECHNOLOGIST: 'Технолог',
  MANAGER: 'Менеджер',
  GROUP_ADMIN: 'Администратор группы',
};

/** Функции, которые можно выключить на уровне группы (просмотр календаря выключить нельзя). */
export const GROUP_FEATURES = [
  'booking.details',
  'booking.create',
  'deal.create',
  'booking.edit',
  'booking.cancel',
  'payment.send',
  'openlines.read',
  'openlines.send',
] as const;
export type GroupFeature = (typeof GROUP_FEATURES)[number];

export function effectivePermissions(role: GroupRole, features: readonly string[]): Permission[] {
  const enabled = new Set<string>(features);
  return ROLE_PERMISSIONS[role].filter((p) => p === 'calendar.view' || p === 'group.manage' || enabled.has(p));
}

export function higherRole(a: GroupRole | null, b: GroupRole): GroupRole {
  return a === null || ROLE_RANK[b] > ROLE_RANK[a] ? b : a;
}

// ---------- контракты API ----------

export type MemberKind = 'USER' | 'DEPARTMENT';
export type BookingMode = 'duration' | 'interval';

export interface GroupMemberDto {
  kind: MemberKind;
  bitrixId: number;
  role: GroupRole;
}

/** Поле сделки в форме брони (из прототипа: обязательность, «два в строку», где показывать). */
export interface DealFieldConfig {
  name: string;
  title?: string;
  required: boolean;
  inlineNext: boolean;
  showCreate: boolean;
  showView: boolean;
  showList: boolean;
  /**
   * Значение по умолчанию в форме создания брони (как в поле ввода: число, ID варианта списка,
   * «Y»/«N»). Ставится, только если в сделке поле пустое; менеджер может поменять.
   */
  defaultValue?: string;
  /** Формула для чисел и сумм: `{OPPORTUNITY} * 50%` (см. `deal-formula.ts`). */
  formula?: string;
}

export interface PaymentStepConfig {
  stageId: string;
  moveStage: boolean;
  templateId: string;
}

/** Вид календаря: календарь (сетка), список, карточки доступности. */
export const CALENDAR_VIEWS = ['calendar', 'list', 'availability'] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];
/** '' — авто: телефон — список, ПК — календарь, «заезд/выезд» — доступность. */
export type CalendarViewSetting = '' | CalendarView;

/** Настройки направления без отдельных колонок (`WorkGroup.options`). */
export interface GroupOptionsDto {
  dealFields: DealFieldConfig[];
  productSectionIds: string[];
  /** resourceId → товары по умолчанию. */
  resourceDefaults: Record<string, { productId: number; quantity: number }[]>;
  views: { desktop: CalendarViewSetting; mobile: CalendarViewSetting };
  /** Типы брони по товарам и подтверждение клиенту для каждого (замена БП 270). */
  bookingTypes?: BookingTypeRule[];
  /** Тип брони обязателен при создании брони (решение владельца 2026-10-22 — для «Бань»). */
  bookingTypeRequired?: boolean;
  /** Автоматические рассылки клиентам по броням группы (например, «подтвердите бронь» за сутки). */
  autoMessages?: AutoMessageRule[];
  payments: {
    prepayment: PaymentStepConfig;
    surcharge: PaymentStepConfig;
    timeoutMinutes: number;
    successStageId: string;
    failStageId: string;
    successTemplateId: string;
    failTemplateId: string;
    /** Фиксированная предоплата, ₽; 0 — сумма из поля сделки «ручная сумма предоплаты». */
    prepaymentAmount?: number;
    /**
     * Сообщение клиенту со ссылкой на оплату. Переменные: {link} — ссылка, {amount} — сумма,
     * {deadline} — до какого времени оплатить, {minutes} — сколько минут на оплату.
     */
    clientMessage?: string;
    /** Сообщение клиенту, когда бронь снята из-за неоплаты в срок; пусто — не отправлять. */
    failMessage?: string;
    /**
     * Отправлять клиенту подтверждение после предоплаты (цепочка типа брони). Выключено по
     * умолчанию: пока на портале работают БП 270/358, клиент получил бы его дважды.
     */
    sendConfirmation?: boolean;
    /** Требовать бронь перед оплатой: счёт выставляется только к действующей брони сделки (по умолчанию да). */
    requireBooking?: boolean;
    /** Сообщение клиенту со ссылкой на доплату ({prepayment} — сумма доплаты). */
    surchargeMessage?: string;
    /**
     * Системный шаблон (`MessageTemplate`, назначение `payment`) сообщения со ссылкой на предоплату /
     * доплату. Не выбран — старый текст группы (`clientMessage` / `surchargeMessage`) или стандартный.
     */
    prepaymentTemplateId?: string;
    surchargeTemplateId?: string;
    /** Предоплата в процентах от суммы сделки, если нет фиксированной и ручной (по умолчанию 100). */
    prepaymentPercent?: number;
    /** Смарт-счёт направления; не задан — выставить счёт из приложения нельзя. */
    invoice?: import('./payments.js').InvoiceConfig;
  };
}

export interface GroupSettingsDto {
  name: string;
  dealCategoryId: number | null;
  resourceIds: number[];
  bookingMode: BookingMode;
  /** duration: минимальная длительность, минут. */
  durationMinutes: number;
  /** interval: заезд/выезд, HH:MM. */
  checkInTime: string;
  checkOutTime: string;
  defaultNights: number;
  techWindowMinutes: number;
  features: GroupFeature[];
  members: GroupMemberDto[];
  /** Не передано при сохранении — сохранённые настройки не меняются. */
  options?: GroupOptionsDto | null;
}

export interface GroupDto extends GroupSettingsDto {
  id: string;
  sort: number;
}

/** Группа глазами текущего пользователя (`GET /api/groups`). */
export interface MyGroupDto {
  id: string;
  name: string;
  role: GroupRole | 'APP_ADMIN';
  permissions: Permission[];
  resourceIds: number[];
  dealCategoryId: number | null;
  bookingMode: BookingMode;
  techWindowMinutes: number;
  /** Для формы брони: длительность по умолчанию (duration) и заезд/выезд (interval). */
  durationMinutes: number;
  checkInTime: string;
  checkOutTime: string;
  defaultNights: number;
  /** Вид календаря по умолчанию на ПК и на телефоне ('' — авто). */
  views: GroupOptionsDto['views'];
  /** Типы брони группы (для выбора в форме брони). */
  bookingTypes: { id: string; title: string }[];
  /** Тип брони обязателен: не указан и не определился по товарам — бронь не создаётся. */
  bookingTypeRequired: boolean;
}

export interface AppSettingsDto {
  /** Сбор метаданных диалогов открытых линий (время последних сообщений). */
  dialogMetadataEnabled: boolean;
  /** Сбор текстов сообщений (персональные данные клиентов) — отдельный переключатель. */
  dialogTextsEnabled: boolean;
  /** Удалять у контакта e-mail с «wazzup» перед запуском оплаты. */
  removeWazzupEmail: boolean;
  /**
   * Создавать в Битрикс24 новые брони (любые даты) и новые сделки, пока интеграция в режиме
   * «только чтение» (решение владельца 2026-10-22). Существующие брони и сделки не меняются.
   */
  createInBitrix: boolean;
  /** Когда разрешение включили (только для показа). */
  createGrantedAt?: string | null;
  /** Менять поля существующих сделок (системные поля брони, ссылки и стадии оплаты); удалять — нет. */
  updateDealFields: boolean;
  admins: { kind: MemberKind; bitrixId: number }[];
  /** Кто ещё может открыть приложение (сотрудники, отделы с вложенными); админы — всегда. */
  appUsers: { kind: MemberKind; bitrixId: number }[];
}
