/**
 * Конструктор брони в одном окне (`docs/features/booking-constructor.md`): какие разделы видны, что в
 * каком состоянии, что мешает перейти к проверке. Чистые функции — состояние формы собирает
 * `BookingForm` в `WizardSnapshot`.
 */

/** Разделы по порядку: кто → группа → дата, ресурс и время | сертификат → товары → поля → проверка. */
export type SectionKey = 'who' | 'when' | 'slot' | 'certificate' | 'goods' | 'fields' | 'comment' | 'review';
export type SectionStatus = 'locked' | 'empty' | 'done' | 'warning' | 'error';
export type DealMode = 'existing' | 'new' | 'service' | 'none';

export const SECTION_TITLES: Record<SectionKey, string> = {
  who: 'Клиент и сделка',
  when: 'Группа',
  slot: 'Ресурс и время',
  certificate: 'Сертификат',
  goods: 'Товары и оплата',
  fields: 'Поля сделки',
  comment: 'Комментарий',
  review: 'Проверка',
};

/** Что известно о форме сейчас (без текстов сводки — их собирает форма). */
export interface WizardSnapshot {
  dealMode: DealMode;
  /** Сделка пришла из встройки — раздел «Кто» не меняется. */
  dealFixed: boolean;
  /** По выбранной сделке уже есть бронь — предупреждение. */
  dealBooked: boolean;
  /** Группа выбрана и доступна для такой брони. */
  groupOk: boolean;
  /** Группа известна заранее (клик по шкале/календарю, одна группа) — «Группа» не открывается первым. */
  groupGiven: boolean;
  /** У группы есть типы сделки и тип не выбран. */
  kindMissing: boolean;
  /** «Покупка сертификата»: вместо ресурса, товаров и полей — раздел «Сертификат». */
  certificate: boolean;
  resourceCount: number;
  /** Ресурс и время: ошибка (занято, стоп, в прошлом) и предупреждение (тех. окно). */
  slotError: string | null;
  slotWarning: string | null;
  /** Сертификат: чего не хватает. */
  certificateError: string | null;
  /** Товары и оплата: ошибка (тип брони, сумма предоплаты, право на оплату, товары не загрузились). */
  goodsError: string | null;
  goodsWarning: string | null;
  /** Поля сделки: подписи незаполненных обязательных; null — ещё загружаются. */
  missingFields: string[] | null;
  fieldsError: string | null;
}

export interface SectionView {
  key: SectionKey;
  status: SectionStatus;
  /** Почему недоступен (locked) или что не так (error/warning). */
  note: string | null;
}

/** Видимые разделы: служебная — без товаров и полей (вместо них комментарий), сертификат — без ресурса. */
export function visibleSections(s: Pick<WizardSnapshot, 'dealMode' | 'certificate'>): SectionKey[] {
  if (s.dealMode === 'service') return ['who', 'when', 'slot', 'comment', 'review'];
  if (s.certificate) return ['who', 'when', 'certificate', 'review'];
  return ['who', 'when', 'slot', 'goods', 'fields', 'review'];
}

/** Проблемы, мешающие проверке: раздел и текст (первой открывается первая). */
export function allIssues(s: WizardSnapshot): { key: SectionKey; text: string }[] {
  const out: { key: SectionKey; text: string }[] = [];
  const keys = visibleSections(s);
  if (s.dealMode === 'none') out.push({ key: 'who', text: 'Выберите сделку, «Новая сделка» или служебную бронь' });
  if (!s.groupOk) out.push({ key: 'when', text: 'Выберите группу' });
  else if (s.kindMissing) out.push({ key: 'when', text: 'Выберите тип сделки' });
  if (keys.includes('slot')) {
    if (!s.resourceCount) out.push({ key: 'slot', text: 'Выберите ресурс и время' });
    else if (s.slotError) out.push({ key: 'slot', text: s.slotError });
  }
  if (keys.includes('certificate') && s.certificateError) out.push({ key: 'certificate', text: s.certificateError });
  if (keys.includes('goods') && s.goodsError) out.push({ key: 'goods', text: s.goodsError });
  if (keys.includes('fields')) {
    if (s.fieldsError) out.push({ key: 'fields', text: s.fieldsError });
    else if (s.missingFields === null) out.push({ key: 'fields', text: 'Поля сделки ещё загружаются' });
    else if (s.missingFields.length) out.push({ key: 'fields', text: missingText(s.missingFields) });
  }
  return out;
}

/** «Не заполнено 2: Гостей, Программа» (не больше трёх имён, дальше +N). */
export function missingText(labels: string[]): string {
  const shown = labels.slice(0, 3).join(', ');
  return `Не заполнено ${labels.length}: ${shown}${labels.length > 3 ? ` +${labels.length - 3}` : ''}`;
}

function lockReason(key: SectionKey, s: WizardSnapshot): string | null {
  switch (key) {
    case 'slot':
    case 'certificate':
      return s.groupOk ? null : 'Сначала выберите группу и дату';
    case 'goods':
      return !s.groupOk ? 'Сначала выберите группу' : s.dealMode === 'none' ? 'Сначала выберите сделку' : null;
    case 'fields':
      return !s.groupOk || s.dealMode === 'none' ? 'Сначала выберите группу и сделку' : null;
    case 'review': {
      const issues = allIssues(s);
      if (!issues.length) return null;
      const missing = issues.find((i) => i.key === 'fields' && s.missingFields?.length);
      return missing && issues.length === 1 ? `Сначала заполните: ${s.missingFields!.slice(0, 3).join(', ')}` : 'Заполните разделы выше';
    }
    default:
      return null;
  }
}

/**
 * Состояние раздела. `touched` — разделы, с которых уже уходили (или нажали «Проверить»): только у них
 * незаполненное становится ошибкой; до этого — «не выбрано». `visited` — открывались хоть раз.
 */
export function sectionView(key: SectionKey, s: WizardSnapshot, touched: ReadonlySet<SectionKey>, visited: ReadonlySet<SectionKey>): SectionView {
  const lock = lockReason(key, s);
  if (lock) return { key, status: 'locked', note: lock };
  const t = touched.has(key);
  switch (key) {
    case 'who':
      if (s.dealMode === 'none') return { key, status: t ? 'error' : 'empty', note: t ? 'Выберите сделку' : null };
      return s.dealBooked ? { key, status: 'warning', note: 'По сделке уже есть бронь' } : { key, status: 'done', note: null };
    case 'when':
      if (!s.groupOk) return { key, status: t ? 'error' : 'empty', note: t ? 'Выберите группу' : null };
      if (s.kindMissing) return { key, status: t ? 'error' : 'empty', note: t ? 'Выберите тип сделки' : null };
      return { key, status: 'done', note: null };
    case 'slot':
      if (!s.resourceCount) return { key, status: t ? 'error' : 'empty', note: t ? 'Выберите ресурс и время' : null };
      if (s.slotError) return { key, status: 'error', note: s.slotError };
      return s.slotWarning ? { key, status: 'warning', note: s.slotWarning } : { key, status: 'done', note: null };
    case 'certificate':
      if (s.certificateError) return { key, status: t ? 'error' : 'empty', note: t ? s.certificateError : null };
      return { key, status: 'done', note: null };
    case 'goods':
      if (s.goodsError) return { key, status: t ? 'error' : 'empty', note: t ? s.goodsError : null };
      if (!visited.has(key)) return { key, status: 'empty', note: null };
      return s.goodsWarning ? { key, status: 'warning', note: s.goodsWarning } : { key, status: 'done', note: null };
    case 'fields':
      if (s.fieldsError) return { key, status: 'error', note: s.fieldsError };
      if (s.missingFields === null) return { key, status: 'empty', note: 'Загрузка полей…' };
      if (s.missingFields.length) return { key, status: t ? 'error' : 'empty', note: t ? missingText(s.missingFields) : null };
      return { key, status: visited.has(key) ? 'done' : 'empty', note: null };
    case 'comment':
      return { key, status: visited.has(key) ? 'done' : 'empty', note: null };
    case 'review':
      return { key, status: 'empty', note: null };
  }
}

/**
 * Какой раздел открыть первым: первый незаполненный по порядку (кроме «Кто» со сделкой из встройки).
 * Клик по шкале во встройке сделки (сделка, ресурс, время известны) — сразу товары.
 */
export function firstSection(s: WizardSnapshot): SectionKey {
  const keys = visibleSections(s);
  for (const k of keys) {
    // «Кто» открыт, пока сделку не подтвердили (из чата и звонка сделка выбрана, но её надо подтвердить).
    if (k === 'who' && (s.dealFixed || s.dealMode === 'new')) continue;
    if (k === 'when' && s.groupOk && !s.kindMissing && s.groupGiven) continue;
    if (k === 'slot' && s.resourceCount && !s.slotError) continue;
    return k;
  }
  return keys[keys.length - 1];
}

/** Следующий раздел после `key` (заблокированные пропускаются только если их нельзя открыть). */
export function nextSection(key: SectionKey, s: WizardSnapshot): SectionKey | null {
  const keys = visibleSections(s);
  const i = keys.indexOf(key);
  return i >= 0 && i < keys.length - 1 ? keys[i + 1] : null;
}

/** Куда идти по «Проверить»: на проверку или в раздел первой проблемы. */
export function reviewTarget(s: WizardSnapshot): SectionKey {
  return allIssues(s)[0]?.key ?? 'review';
}
