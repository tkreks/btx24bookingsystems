/**
 * Сообщения клиенту по типу брони (замена БП 270): тип определяется по товарам сделки, у каждого
 * типа — своя цепочка сообщений (текст + файлы с Диска Битрикс24). Чистые функции — общие для api
 * и web (предпросмотр в настройках).
 */

/** Файл с Диска Битрикс24 (ID объекта Диска + имя для показа). */
export interface DiskFileRef {
  id: number;
  name: string;
}

export interface ClientMessageStep {
  text: string;
  files: DiskFileRef[];
}

/**
 * Тип брони. Подходит, если в названиях товаров сделки есть любое из `keywords` (без учёта
 * регистра). Правила проверяются по порядку — первое подошедшее побеждает (как ветки БП).
 */
export interface BookingTypeRule {
  id: string;
  title: string;
  keywords: string[];
  /** Значение поля сделки «Тип бронирования» (ID варианта списка); '' — не заполнять. */
  dealTypeValue: string;
  /** Программа: `@keyword` — совпавшее ключевое слово (Алатырь, Елань…), иначе — текст как есть. */
  program: string;
  /** Подтверждение после оплаты — по порядку. */
  confirmation: ClientMessageStep[];
}

export const PROGRAM_FROM_KEYWORD = '@keyword';

/** Текст по умолчанию: бронь снята из-за неоплаты (правится в настройках группы). */
export const DEFAULT_FAIL_MESSAGE =
  'Оплата не поступила в течение {minutes} минут, поэтому бронь на {date_start} снята. Если планы в силе — напишите нам, подберём время.';

/** Текст по умолчанию для сообщения клиенту со ссылкой на оплату (правится в настройках группы). */
export const DEFAULT_CLIENT_MESSAGE =
  'Здравствуйте! Для подтверждения брони внесите предоплату {prepayment} ₽ по ссылке: {link}\n' +
  'Оплатить нужно в течение {minutes} минут (до {deadline}), иначе бронь будет снята.';


/** Переменные шаблонов: {name} → описание (для подсказки в настройках). */
export const TEMPLATE_VARIABLES: Record<string, string> = {
  client_name: 'имя клиента (контакт сделки)',
  date_start: 'дата начала визита',
  time_start: 'время начала',
  date_end: 'дата завершения',
  time_end: 'время завершения',
  program: 'программа (по типу брони)',
  guests: 'количество гостей',
  house: 'дом: альтернативное имя ресурса, если задано, иначе название ресурса',
  amount: 'стоимость (сумма сделки)',
  prepayment: 'сумма предоплаты',
  link: 'ссылка на оплату',
  minutes: 'минут на оплату',
  deadline: 'оплатить до',
};

/** Тип брони по названиям товаров сделки; null — не определён (сообщение не отправляем). */
export function detectBookingType(
  rules: BookingTypeRule[],
  productNames: string[],
): { rule: BookingTypeRule; program: string } | null {
  const hay = productNames.map((n) => n.toLocaleLowerCase('ru'));
  for (const rule of rules) {
    const hit = rule.keywords.find((k) => k.trim() && hay.some((n) => n.includes(k.trim().toLocaleLowerCase('ru'))));
    if (hit !== undefined) return { rule, program: rule.program === PROGRAM_FROM_KEYWORD ? hit.trim() : rule.program };
  }
  return null;
}

/** Подставить переменные `{name}`; неизвестные и пустые остаются как есть — их видно при проверке. */
export function renderTemplate(text: string, vars: Partial<Record<string, string | number | null | undefined>>): string {
  return text.replace(/\{([a-z_]+)\}/g, (m, name: string) => {
    const v = vars[name];
    return v === undefined || v === null || v === '' ? m : String(v);
  });
}

/** Переменные шаблона, которых нет в списке (опечатки), — для предупреждения в настройках. */
export function unknownVariables(text: string): string[] {
  return [...new Set([...text.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]).filter((n) => !(n in TEMPLATE_VARIABLES)))];
}

/** Имя ресурса для клиента: альтернативное, если задано, иначе — как в Битрикс24. */
export function clientResourceName(r: { name: string; clientName?: string | null }): string {
  return r.clientName?.trim() || r.name;
}

/** `GET /api/admin/resources` — ресурсы (зеркало Битрикс24) с альтернативным именем. */
export interface ResourceAdminDto {
  resourceId: number;
  name: string;
  clientName: string | null;
  archived: boolean;
}

/** `GET /api/admin/disk` — хранилища, папки и файлы Диска для выбора вложений. */
export interface DiskItemDto {
  kind: 'storage' | 'folder' | 'file';
  id: number;
  name: string;
  size: number | null;
}

/** `GET /api/admin/bizproc-import?templateId=` — правила и сообщения из БП для формы группы. */
export interface BizprocImportDto {
  templateName: string;
  rules: BookingTypeRule[];
}
