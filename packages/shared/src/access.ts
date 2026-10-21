// Роли и права в группах (ADR 0005). Источник правды и для api (проверка), и для web (скрытие
// недоступного). Право в группе = права роли ∩ функции, включённые в группе.

export const PERMISSIONS = [
  'calendar.view', // видеть календарь ресурсов группы
  'booking.details', // видеть данные броней и сделок (без него — только занятость/тех. окна)
  'booking.create',
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
  /** Вид календаря по умолчанию на ПК и на телефоне ('' — авто). */
  views: GroupOptionsDto['views'];
}

export interface AppSettingsDto {
  /** Сбор метаданных диалогов открытых линий (время последних сообщений). */
  dialogMetadataEnabled: boolean;
  /** Сбор текстов сообщений (персональные данные клиентов) — отдельный переключатель. */
  dialogTextsEnabled: boolean;
  /** Удалять у контакта e-mail с «wazzup» перед запуском оплаты. */
  removeWazzupEmail: boolean;
  admins: { kind: MemberKind; bitrixId: number }[];
}
