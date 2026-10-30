// Дубли контактов (решение владельца 2026-10-30): блок дашборда находит контакты одного клиента —
// по телефону, почте, имени — и объединяет их (`crm.entity.mergeBatch`) с выбором значений полей, как в
// окне объединения Битрикс24. Объединяют только постоянные администраторы приложения; позже — отметка
// «есть дубли» везде, где показан контакт.

/** Совпадение, по которому контакты считаются одним клиентом. */
export const DUPLICATE_REASONS = ['phone', 'email', 'name', 'messenger'] as const;
export type DuplicateReason = (typeof DUPLICATE_REASONS)[number];
/**
 * `messenger` — один и тот же ID клиента в мессенджере (поля контакта Wazzup и собственные BTX24_*, по
 * сопоставлению полей портала); значение — для людей: «Telegram 5789248202», «WhatsApp LID 1234…».
 */
export const DUPLICATE_REASON_LABELS: Record<DuplicateReason, string> = { phone: 'Телефон', email: 'Почта', name: 'Имя', messenger: 'Мессенджер' };

export interface DuplicateContactDto {
  id: number;
  name: string;
  phones: string[];
  emails: string[];
  /** ISO; null — неизвестно. */
  createdAt: string | null;
  modifiedAt: string | null;
  assignedById: number | null;
  /**
   * Аватарка контакта (URL, открывается в <img> без токена): фото контакта из копии CRM, иначе — аватарка
   * клиента в его последнем чате открытой линии. Нет — null (показываются инициалы).
   */
  photo?: string | null;
  /**
   * Каналы клиента из поля IM контакта (открытые линии и мессенджеры), коды как у `messageChannel`:
   * whatsapp, telegram, max, instagram, vkgroup, viber, avito, facebook, livechat, imessage. Без повторов.
   */
  messengers?: string[];
}

/** Коды каналов, которые возвращает поле `messengers` (остальные отбрасываются). */
export const DUPLICATE_CHANNELS = ['whatsapp', 'telegram', 'max', 'instagram', 'vkgroup', 'viber', 'avito', 'facebook', 'livechat', 'imessage'] as const;

/** Группа дублей: контакты, связанные общими телефонами/почтой (или одинаковым именем). */
export interface DuplicateGroupDto {
  /** Стабильный ключ группы (для списка и повторного открытия). */
  key: string;
  /** Что совпало: вид и значение (телефон — цифрами, почта — строчными, имя — как у контакта). */
  reasons: { kind: DuplicateReason; value: string }[];
  /** По дате создания: самый ранний первым (его предлагается оставить), без даты — в конце. */
  contacts: DuplicateContactDto[];
}

/** `GET /api/contacts/duplicates?by=all|phone|email|name&q=&cursor=&limit=` */
export interface ContactDuplicatesDto {
  groups: DuplicateGroupDto[];
  /** Групп всего по фильтру. */
  total: number;
  /** Курсор следующей страницы; null — конец. */
  nextCursor: string | null;
  /** Контактов просмотрено (копия CRM). */
  scanned: number;
  /** Когда построен индекс дублей (ISO). */
  builtAt: string;
}

/** Поле в окне сравнения. */
export interface ContactCompareFieldDto {
  code: string;
  label: string;
  /** single — одно значение (выбрать из контактов); multi — телефоны/почта/мессенджеры (объединяются все). */
  kind: 'single' | 'multi';
  /** Значение для показа по ID контакта: строка, список (multi) или null — пусто. */
  values: Record<string, string | string[] | null>;
  /** Заполнено по-разному у нескольких контактов — нужно выбрать. */
  conflict: boolean;
}

/** `GET /api/contacts/duplicates/compare?ids=1,2,3` — свежие данные из Битрикс24. */
export interface ContactCompareDto {
  contacts: (DuplicateContactDto & { dealsCount: number })[];
  fields: ContactCompareFieldDto[];
  /** Основной по умолчанию: с наибольшим числом сделок, при равенстве — самый старый. */
  suggestedPrimaryId: number;
}

/** `POST /api/contacts/duplicates/merge` */
export interface MergeContactsDto {
  idempotencyKey: string;
  /** Остаётся (первый в `crm.entity.mergeBatch`). */
  primaryId: number;
  /** Все контакты группы, включая основной (2–10). */
  ids: number[];
  /** Код поля → ID контакта, чьё значение оставить (для полей с `conflict`). */
  choices: Record<string, number>;
}

export interface MergeContactsResultDto {
  status: 'merged' | 'conflict';
  primaryId: number;
  /** Удалены при объединении. */
  removedIds: number[];
  /** CONFLICT от Битрикс24: поля, которые не удалось согласовать (объединить вручную в Битрикс24). */
  conflicts: string[];
  warnings: string[];
}

export const MERGE_MAX_CONTACTS = 10;
