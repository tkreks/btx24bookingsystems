import {
  GROUP_FEATURES,
  type DealFieldConfig,
  type GroupDto,
  type GroupOptionsDto,
  type GroupSettingsDto,
} from '@btx24/shared';

export function newGroup(): GroupSettingsDto {
  return {
    name: '',
    dealCategoryId: null,
    resourceIds: [],
    bookingMode: 'duration',
    durationMinutes: 60,
    checkInTime: '14:00',
    checkOutTime: '12:00',
    defaultNights: 1,
    techWindowMinutes: 0,
    features: [...GROUP_FEATURES],
    members: [],
  };
}

/** PUT принимает только настройки; options переносим целиком, без потери настроек прототипа. */
export function groupSettings(group: GroupDto): GroupSettingsDto {
  const { id: _id, sort: _sort, ...settings } = group;
  return structuredClone(settings);
}

/** Настройки направления по умолчанию (новая группа или группа без настроек прототипа). */
export function defaultOptions(): GroupOptionsDto {
  const step = { stageId: '', moveStage: false, templateId: '' };
  return {
    dealFields: [],
    productSectionIds: [],
    resourceDefaults: {},
    views: { desktop: '', mobile: '' },
    payments: {
      prepayment: { ...step },
      surcharge: { ...step },
      timeoutMinutes: 60,
      successStageId: '',
      failStageId: '',
      successTemplateId: '',
      failTemplateId: '',
      prepaymentAmount: 0,
      clientMessage: DEFAULT_CLIENT_MESSAGE,
    },
  };
}

/** Текст по умолчанию для сообщения клиенту со ссылкой на оплату (правится в настройках группы). */
export const DEFAULT_CLIENT_MESSAGE =
  'Здравствуйте! Для подтверждения брони внесите предоплату {amount} по ссылке: {link}\n' +
  'Оплатить нужно в течение {minutes} минут (до {deadline}), иначе бронь будет снята.';

/** Новое поле сделки — как в прототипе: видно при создании и в карточке, в списке — нет. */
export function newDealField(name: string): DealFieldConfig {
  return { name, required: false, inlineNext: false, showCreate: true, showView: true, showList: false };
}

/** Сдвиг элемента на одну позицию; за границы не выходит. */
export function move<T>(list: T[], index: number, delta: -1 | 1): T[] {
  const to = index + delta;
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

/** Товары по умолчанию ресурса без пустых строк (пустой список — ключ удаляется). */
export function setResourceDefaults(
  defaults: GroupOptionsDto['resourceDefaults'],
  resourceId: number,
  rows: { productId: number; quantity: number }[],
): GroupOptionsDto['resourceDefaults'] {
  const next = { ...defaults };
  const clean = rows.filter((r) => r.productId > 0 && r.quantity > 0);
  if (clean.length) next[String(resourceId)] = clean;
  else delete next[String(resourceId)];
  return next;
}
