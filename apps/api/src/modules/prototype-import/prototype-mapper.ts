import { GROUP_FEATURES, type BookingMode, type GroupOptionsDto } from '@btx24/shared';

/**
 * Преобразование `booking_local_settings_v3.json` прототипа (settings v8) в нашу модель.
 * Чистая функция: без БД и без хеширования — их делает ImportService. Разбор формата —
 * docs/prototype/node-red-v3.md §3.
 */

export interface MappedGroup {
  legacyId: string;
  sort: number;
  name: string;
  dealCategoryId: number | null;
  bookingMode: BookingMode;
  durationMinutes: number;
  checkInTime: string;
  checkOutTime: string;
  defaultNights: number;
  techWindowMinutes: number;
  resourceIds: number[];
  options: GroupOptionsDto;
}

export interface MappedExternalUser {
  login: string;
  /** Открытый пароль из файла — только в памяти, до хеширования. */
  password: string;
  role: 'VIEWER' | 'TECHNOLOGIST';
  allGroups: boolean;
  legacyGroupIds: string[];
  visibleFields: string[] | null;
}

export interface MappedPrototype {
  groups: MappedGroup[];
  externalUsers: MappedExternalUser[];
  removeWazzupEmail: boolean;
  /** Все функции включены: в прототипе пользователям Битрикс24 было доступно всё. */
  features: string[];
  warnings: string[];
}

type Raw = Record<string, unknown>;
const str = (v: unknown, d = '') => (v === undefined || v === null ? d : String(v).trim());
const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : d);
const time = (v: unknown, d: string) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(str(v)) ? str(v) : d);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));
const view = (v: unknown) => (['calendar', 'list', 'availability'].includes(str(v)) ? (str(v) as 'calendar') : '');

export function mapPrototype(raw: unknown): MappedPrototype {
  const doc = (raw ?? {}) as Raw;
  const warnings: string[] = [];
  if (Number(doc.version) !== 8) warnings.push(`Ожидалась версия настроек 8, в файле — ${str(doc.version, 'нет')}`);
  const rawGroups = (Array.isArray(doc.groups) ? doc.groups : []) as Raw[];
  const defaultId = str(doc.defaultGroupId);

  // Группа по умолчанию — первой в списке.
  const ordered = [...rawGroups].sort((a, b) => Number(str(b.id) === defaultId) - Number(str(a.id) === defaultId));
  const groups = ordered.map((g, i): MappedGroup => {
    const id = str(g.id);
    const mode: BookingMode = str(g.bookingMode) === 'interval' ? 'interval' : 'duration';
    const cat = str(g.kanbanCategoryId);
    const resourceDefaults: GroupOptionsDto['resourceDefaults'] = {};
    for (const [rid, items] of Object.entries((g.resourceDefaults ?? {}) as Record<string, unknown>)) {
      const list = (Array.isArray(items) ? items : [items]) as Raw[];
      const clean = list
        .map((x) => ({ productId: num(x?.productId, 0), quantity: Math.max(1, num(x?.quantity, 1)) }))
        .filter((x) => x.productId > 0);
      if (/^\d+$/.test(rid) && clean.length) resourceDefaults[rid] = clean.slice(0, 50);
    }
    const step = (prefix: 'prepayment' | 'surcharge') => ({
      stageId: str(g[`${prefix}StageId`]),
      moveStage: Boolean(g[`${prefix}MoveStage`]),
      templateId: str(g[`${prefix}TemplateId`]),
    });
    return {
      legacyId: id,
      sort: i * 10,
      name: str(g.title, `Группа ${i + 1}`).slice(0, 100),
      dealCategoryId: /^\d+$/.test(cat) ? Number(cat) : null,
      bookingMode: mode,
      durationMinutes: clamp(num(g.durationHours, 1) * 60, 1, 10080),
      checkInTime: time(g.checkInTime, '14:00'),
      checkOutTime: time(g.checkOutTime, '12:00'),
      defaultNights: clamp(num(g.defaultDays, 1), 0, 365),
      techWindowMinutes: clamp(num(g.techWindowMinutes ?? g.technicalWindowMinutes, 0), 0, 1440),
      resourceIds: [...new Set(((Array.isArray(g.resourceIds) ? g.resourceIds : []) as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n > 0))],
      options: {
        dealFields: ((Array.isArray(g.dealFields) ? g.dealFields : []) as Raw[])
          .filter((f) => /^[A-Z0-9_]+$/i.test(str(f?.name)))
          .slice(0, 80)
          .map((f) => ({
            name: str(f.name),
            ...(str(f.title) ? { title: str(f.title).slice(0, 200) } : {}),
            required: Boolean(f.required),
            inlineNext: Boolean(f.inlineNext),
            showCreate: f.showCreate === undefined ? true : Boolean(f.showCreate),
            showView: f.showView === undefined ? true : Boolean(f.showView),
            showList: Boolean(f.showList),
          })),
        productSectionIds: ((Array.isArray(g.productSectionIds) ? g.productSectionIds : []) as unknown[]).map((x) => str(x)).filter(Boolean).slice(0, 500),
        resourceDefaults,
        views: { desktop: view(g.defaultDesktopView), mobile: view(g.defaultMobileView) },
        payments: {
          prepayment: step('prepayment'),
          surcharge: step('surcharge'),
          timeoutMinutes: clamp(num(g.paymentTimeoutMinutes, 60), 1, 10080),
          successStageId: str(g.paymentSuccessStageId),
          failStageId: str(g.paymentFailStageId),
          successTemplateId: str(g.paymentSuccessTemplateId),
          failTemplateId: str(g.paymentFailTemplateId),
        },
      },
    };
  });

  const known = new Set(groups.map((g) => g.legacyId));
  const externalUsers = ((Array.isArray(doc.externalUsers) ? doc.externalUsers : []) as Raw[]).flatMap((u): MappedExternalUser[] => {
    const login = str(u.login).slice(0, 100);
    const password = str(u.password);
    if (!login || !password) {
      warnings.push(`Пользователь прямой ссылки без логина или пароля пропущен`);
      return [];
    }
    const groupIds = ((Array.isArray(u.groupIds) ? u.groupIds : []) as unknown[]).map((x) => str(x)).filter(Boolean);
    const unknown = groupIds.filter((id) => !known.has(id));
    if (unknown.length) warnings.push(`У «${login}» указаны несуществующие группы: ${unknown.join(', ')} — пропущены`);
    const perms = (u.permissions ?? {}) as Raw;
    const fields = Array.isArray(perms.fields) ? (perms.fields as unknown[]).map((x) => str(x)).filter((x) => /^[A-Z0-9_]+$/i.test(x)) : [];
    return [
      {
        login,
        password,
        role: str(u.role).toLowerCase() === 'technologist' ? 'TECHNOLOGIST' : 'VIEWER',
        // В прототипе пустой список групп = доступ ко всем группам.
        allGroups: groupIds.length === 0,
        legacyGroupIds: groupIds.filter((id) => known.has(id)),
        visibleFields: perms.allFields === false ? fields : null,
      },
    ];
  });
  if (externalUsers.some((u) => u.password.length < 8)) warnings.push('У части пользователей прямой ссылки пароль короче 8 символов — рекомендуется сменить');

  return { groups, externalUsers, removeWazzupEmail: Boolean(doc.removeWazzupEmail), features: [...GROUP_FEATURES], warnings };
}
