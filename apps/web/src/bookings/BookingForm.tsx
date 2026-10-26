import { freshPoll } from '../fresh-poll.js';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  canUsePaymentMode,
  CERTIFICATE_KIND_LABELS,
  CERTIFICATE_KINDS,
  DEAL_KIND_HINTS,
  DEAL_KIND_LABELS,
  DEAL_KIND_PAYMENT,
  DEAL_KINDS,
  PAYMENT_MODE_LABELS,
  PAYMENT_MODES,
  todayIn,
  zonedTimeToUtc,
  type BookingCatalogDto,
  type CalendarDay,
  type CreateBookingResultDto,
  type CrmContactHit,
  type CrmDealHit,
  type CertificateKind,
  type CrmSearchDto,
  type DealBookingTone,
  type DealKind,
  type DealFormDto,
  type DealFormField,
  type DealProductRowDto,
  type MyGroupDto,
  type PaymentMode,
  type RecentDealsDto,
  type SellCertificateResultDto,
} from '@btx24/shared';
import { apiGet, apiPost } from '../api.js';
import { fmtDate, fmtDateTime, fmtMoney, fmtTime, plusMonths, shiftDate } from '../format.js';
import { defaultPeriod, periodToUtc, type PeriodFields } from './booking-form.js';
import { ClientPicker, ContactName } from './ClientPicker.js';
import { Avatar } from '../openlines/Avatar.js';
import { openCrm } from '../b24.js';
import { ColorLegend, type LegendItem } from '../ColorLegend.js';
import { DealFieldsEditor, useDealFieldValues } from './DealFieldsEditor.js';
import { ProductsEditor, productsTotal, rowTotal, type ProductRow } from './ProductsEditor.js';
import { DayStrip, isPastStart, SlotPicker, slotStateOf, useNow } from './SlotPicker.js';
import { MinimizeButton } from '../Minimize.js';
import {
  allIssues,
  firstSection,
  nextSection,
  SECTION_TITLES,
  sectionView,
  visibleSections,
  type SectionKey,
  type SectionView,
  type WizardSnapshot,
} from './booking-wizard-model.js';

export interface BookingFormContext {
  date: string;
  time?: string;
  groupId?: string | null;
  resourceId?: number | null;
  /** Сделка, из которой открыли (встройка) — раздел «Клиент и сделка» не меняется. */
  dealId?: number | null;
  contactId?: number | null;
  clientName?: string | null;
  /** Открытые сделки клиента (из чата или сделки): сумма, дата, бронь по сделке. */
  openDeals?: {
    id: number;
    title: string;
    categoryId?: number | null;
    opportunity?: number | null;
    createdAt?: string | null;
    booking?: { start: string; end: string; resources: string[] } | null;
    tone?: DealBookingTone;
  }[];
  /** Какую сделку выбрать сразу (карточка звонка: сделка звонка или самая новая). */
  selectDealId?: number | null;
}

/** Итог мастера: бронь (или проданный сертификат) и нужно ли сразу окно оплаты (с суммой). */
export interface WizardResult {
  booking: CreateBookingResultDto | null;
  dealId: number | null;
  /** Открыть окно оплаты по `dealId`; `amount` — подставить (иначе расчёт); `fixedDeal` — без брони. */
  payment: { amount: number | null; fixedDeal: boolean } | null;
  /** Текст для сотрудника: что создано и предупреждения. */
  note: string;
}

/**
 * `none` — ещё не выбрали (мастер из меню: клиента и сделки пока нет). Название новой сделки не
 * вводится — собирается при создании: клиент, дата брони, ресурс (`newDealTitle`).
 */
type DealChoice = { mode: 'existing'; dealId: number } | { mode: 'new' } | { mode: 'service' } | { mode: 'none' };
type DealCard = {
  id: number;
  title: string;
  categoryId?: number | null;
  closed?: boolean;
  client?: string | null;
  opportunity?: number | null;
  lastActivityAt?: string | null;
  createdAt?: string | null;
  /** Бронь по сделке (текущая или будущая) — карточка красная: вторую бронь, скорее всего, не сюда. */
  booking?: { start: string; end: string; resources: string[] } | null;
  /** 🔴 есть бронь, 🟡 брони нет, но поля брони заполнены, 🟢 пустая. */
  tone?: DealBookingTone;
  /** Кто последним изменил сделку. */
  modifiedBy?: CrmDealHit['modifiedBy'];
};
/** Сделок клиента сразу и сколько добавляет «Показать ещё» (по 2 в строке). */
const DEALS_STEP = 4;

/** Начало брони уже прошло. */
const PAST_START_ERROR = 'Начало брони уже прошло — выберите сегодня позже текущего времени или другой день';

/** «4 ч», «1 сут 2 ч», «45 мин» — длительность брони для сводки. */
export function durationText(ms: number): string {
  const min = Math.round(ms / 60_000);
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  return [d ? `${d} сут` : '', h ? `${h} ч` : '', m ? `${m} мин` : ''].filter(Boolean).join(' ') || '0 мин';
}

/** «12 мин назад», «3 ч назад», «вчера», «5 дн назад» — давность активности сделки. */
export function agoText(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.round(h / 24);
  return d === 1 ? 'вчера' : `${d} дн назад`;
}

/** «пн 27.10» — день брони в сводке. */
export function dayShort(date: string): string {
  if (!date) return '';
  const wd = new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', weekday: 'short' }).format(new Date(`${date}T12:00:00Z`));
  return `${wd} ${date.slice(8, 10)}.${date.slice(5, 7)}`;
}

/** «2 ночи», «1 ночь», «5 ночей». */
export function nightsText(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  return `${n} ${m10 === 1 && m100 !== 11 ? 'ночь' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'ночи' : 'ночей'}`;
}

/** Цвет сделки словами (сводка «Кто»). */
const TONE_WORDS: Record<DealBookingTone, string> = { booked: 'есть бронь', filled: 'поля заполнены', empty: 'пустая' };

/**
 * Конструктор брони в одном окне (`docs/features/booking-constructor.md`, макет
 * `docs/prototype/ui/booking-constructor.html`): разделы Кто → Группа и дата → Ресурс и время (или
 * Сертификат) → Товары и оплата → Поля сделки → Проверка. Открыт ровно один раздел, заполненные
 * свёрнуты в строку-сводку, в любой можно вернуться. Создание — только с проверки.
 */
export function BookingForm({
  groups,
  timezone,
  context,
  callPlacement = false,
  onDone,
  onClose,
}: {
  groups: MyGroupDto[];
  timezone: string;
  context: BookingFormContext;
  callPlacement?: boolean;
  /** Создано: бронь или сертификат; `payment` — сразу предложить счёт (у кого есть право). */
  onDone: (r: WizardResult) => void;
  onClose: () => void;
}) {
  const allowed = groups.filter((g) => g.permissions.includes('booking.create'));
  const [groupId, setGroupId] = useState(() => {
    // Из встройки сделки без клика по шкале — группа по воронке сделки.
    const category = context.dealId && !context.resourceId ? context.openDeals?.find((d) => d.id === context.dealId)?.categoryId : null;
    return (
      (category != null ? allowed.find((g) => g.dealCategoryId === category)?.id : undefined) ??
      allowed.find((g) => g.id === context.groupId || (context.resourceId && g.resourceIds.includes(context.resourceId)))?.id ??
      allowed[0]?.id ??
      ''
    );
  });
  // Группу выбрали руками — смена сделки её не меняет (только подсказка).
  const [groupManual, setGroupManual] = useState(false);
  const group = allowed.find((g) => g.id === groupId);
  // Тип сделки (группы с `dealKinds`): от него — разделы, оплата и обязательные поля.
  const [kind, setKind] = useState<DealKind | null>('visit');
  const modes = useMemo(() => PAYMENT_MODES.filter((m) => canUsePaymentMode(group?.permissions ?? [], m)), [group]);
  // Календарь мог остаться на прошедшем дне (страницу открыли до полуночи) — бронь начинаем с сегодня.
  const startDay = context.date < todayIn(timezone) ? todayIn(timezone) : context.date;
  const [period, setPeriod] = useState<PeriodFields>(() =>
    group ? defaultPeriod(group, startDay, context.time) : { startDate: startDay, startTime: '14:00', endDate: startDay, endTime: '18:00' },
  );
  const [resourceIds, setResourceIds] = useState<number[]>(context.resourceId ? [context.resourceId] : []);
  // Клиент брони: из чата/сделки — сразу; из меню — поиском или из сделок с последней активностью.
  const [client, setClient] = useState<{ contactId: number | null; name: string | null }>({ contactId: context.contactId ?? null, name: context.clientName ?? null });
  const [dealList, setDealList] = useState<DealCard[]>(context.openDeals ?? []);
  const [searching, setSearching] = useState(false);
  // Карточка клиента (имя «Имя Фамилия», фото) — из поиска или подгружается по контакту.
  const [clientCard, setClientCard] = useState<CrmContactHit | null>(null);
  useEffect(() => {
    const id = client.contactId;
    if (!id || clientCard?.id === id) return;
    let active = true;
    apiGet<CrmSearchDto>(`/crm/search?contactId=${id}`).then(
      (r) => active && r.contacts[0] && setClientCard(r.contacts[0]),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [client.contactId, clientCard?.id]);
  const card = client.contactId && clientCard?.id === client.contactId ? clientCard : null;
  const deals = [...dealList].sort(
    (a, b) => Number(b.id === context.dealId) - Number(a.id === context.dealId) || Number(!!a.closed) - Number(!!b.closed) || b.id - a.id,
  );
  const [deal, setDeal] = useState<DealChoice>(() =>
    context.dealId
      ? { mode: 'existing', dealId: context.dealId }
      : context.selectDealId && deals.some((d) => d.id === context.selectDealId)
        ? { mode: 'existing', dealId: context.selectDealId }
        : deals[0]
          ? { mode: 'existing', dealId: deals[0].id }
          : context.contactId
            ? { mode: 'new' }
            : { mode: 'none' },
  );
  const [dealsShown, setDealsShown] = useState(DEALS_STEP);
  const kindsOn = !!group?.dealKinds && deal.mode !== 'service';
  // «Бронирование сертификатом»: ссылку на оплату решает менеджер; сумма — «Сумма предоплаты» сделки.
  const [sendLink, setSendLink] = useState(false);
  // null — не правили: «Сумма предоплаты» из сделки (если заполнена).
  const [prepayEdited, setPrepayAmount] = useState<string | null>(null);
  // «Покупка сертификата»: номинал, бумажный/электронный, на чьё имя, срок (по умолчанию год).
  const [cert, setCert] = useState<{ nominal: string; kind: CertificateKind; holder: string; validUntil: string }>(() => ({
    nominal: '',
    kind: 'electronic',
    holder: context.clientName ?? '',
    validUntil: plusMonths(todayIn(timezone), 12),
  }));
  const [guests, setGuests] = useState('');
  const [comment, setComment] = useState('');
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('prepayment');
  // '' — определить по товарам сделки (как БП 270).
  const [bookingTypeId, setBookingTypeId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; section: SectionKey | null } | null>(null);
  // Бронь создана, но с предупреждениями (поля/товары не записались) — экран результата.
  const [result, setResult] = useState<{ r: WizardResult; warnings: string[] } | null>(null);
  // Один ключ на открытие формы: повторная отправка (обрыв связи) не создаст вторую бронь.
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);

  // Раздел открыт (null — первый по точке входа), с каких уже уходили (там пустое — ошибка) и какие открывались.
  const [opened, setOpened] = useState<SectionKey | null>(null);
  const [touched, setTouched] = useState<Set<SectionKey>>(new Set());
  const [visited, setVisited] = useState<Set<SectionKey>>(new Set());
  // Поля сделки, с которых ушли пустыми (подсветка обязательных до ухода с раздела).
  const [blurred, setBlurred] = useState<Set<string>>(new Set());

  // «Кто» без клиента: 20 сделок с последней активностью (чаты, звонки, дела).
  const needRecent = !client.contactId && !dealList.length && !context.dealId;
  const [recent, setRecent] = useState<{ deals: CrmDealHit[] | null; error: string }>({ deals: null, error: '' });
  useEffect(() => {
    if (!needRecent || recent.deals) return;
    let active = true;
    apiGet<RecentDealsDto>('/crm/recent-deals').then(
      (r) => active && setRecent({ deals: r.deals, error: '' }),
      (e) => active && setRecent({ deals: [], error: e instanceof Error ? e.message : 'Не удалось загрузить сделки' }),
    );
    return () => {
      active = false;
    };
  }, [needRecent, recent.deals]);

  // Дни брони группы (с первого по последний, до 14): занятость ресурсов на всё время брони.
  const bookingDates = datesBetween(period.startDate, period.endDate);
  const dayKey = `${groupId}|${bookingDates.join(',')}`;
  const [day, setDay] = useState<{ key: string; data: CalendarDay | null } | null>(null);
  useEffect(() => {
    if (!groupId) return;
    let active = true;
    const [gid, dates] = dayKey.split('|');
    const stop = freshPoll(() =>
      Promise.all(dates.split(',').map((date) => apiGet<CalendarDay>(`/calendar?date=${date}&groupId=${encodeURIComponent(gid)}`))).then(
        (list) => active && setDay({ key: dayKey, data: mergeDays(list) }),
        () => active && setDay({ key: dayKey, data: null }),
      ),
    );
    return () => {
      active = false;
      stop();
    };
  }, [groupId, dayKey]);
  const dayData = day?.key === dayKey ? day.data : null;
  // Новые дни ещё грузятся — таймлайн показывает прежние под загрузчиком (проверки — только по свежим).
  const dayLoading = day?.key !== dayKey;
  const list = dayData?.resources ?? (day?.data?.resources ?? null);

  // Поля сделки группы (флаг «С»); у существующей сделки — с её текущими значениями.
  const formKey = deal.mode === 'service' || deal.mode === 'none' || !groupId ? '' : `${groupId}:${deal.mode === 'existing' ? deal.dealId : ''}`;
  const [dealForm, setDealForm] = useState<{ key: string; form: DealFormDto | null; error: string } | null>(null);
  useEffect(() => {
    if (!formKey) return;
    let active = true;
    const [gid, did] = formKey.split(':');
    apiGet<DealFormDto>(`/deal-form?groupId=${encodeURIComponent(gid)}${did ? `&dealId=${did}` : ''}`).then(
      (f) => active && setDealForm({ key: formKey, form: f, error: '' }),
      (e) => active && setDealForm({ key: formKey, form: null, error: e instanceof Error ? e.message : 'Не удалось загрузить поля сделки' }),
    );
    return () => {
      active = false;
    };
  }, [formKey]);
  const currentForm = formKey && dealForm?.key === formKey ? dealForm : null;
  // «Сумма предоплаты» существующей сделки — в поле суммы ссылки (менеджер может поправить).
  const dealPrepay = currentForm?.form?.prepaymentAmount ?? null;
  const prepayAmount = prepayEdited ?? (dealPrepay ? String(dealPrepay) : '');
  // Тип брони — отдельным выбором (с автоопределением по товарам).
  const createFields = useMemo(() => (currentForm?.form?.fields ?? []).filter((f) => f.showCreate && f.role !== 'bookingType'), [currentForm]);
  const fieldState = useDealFieldValues(createFields, 'create', currentForm ? formKey : '');
  // В сделке уже заполнены поля — спросить: оставить или очистить (один раз на сделку).
  const filled = deal.mode === 'existing' ? createFields.filter((f) => !f.readOnly && f.value.trim()) : [];
  const [decided, setDecided] = useState<{ key: string; cleared: number }>({ key: '', cleared: 0 });
  // После решения — куда идти (раздел полей или проверка).
  const [askFields, setAskFields] = useState<SectionKey | null>(null);
  const needDecision = filled.length > 0 && decided.key !== formKey;

  // Товары: каталог группы; у существующей сделки — её товары (строки заменяются целиком), у новой —
  // товары по умолчанию выбранных ресурсов.
  const [catalog, setCatalog] = useState<{ groupId: string; data: BookingCatalogDto | null } | null>(null);
  useEffect(() => {
    if (!groupId) return;
    let active = true;
    apiGet<BookingCatalogDto>(`/booking-catalog?groupId=${encodeURIComponent(groupId)}`).then(
      (data) => active && setCatalog({ groupId, data }),
      () => active && setCatalog({ groupId, data: null }),
    );
    return () => {
      active = false;
    };
  }, [groupId]);
  const cat = catalog?.groupId === groupId ? catalog.data : null;
  const [products, setProducts] = useState<{ key: string; rows: ProductRow[]; dirty: boolean; error?: string } | null>(null);
  const existingDealId = deal.mode === 'existing' ? deal.dealId : null;
  const productsKey = existingDealId ? `deal:${existingDealId}` : deal.mode;
  // Товары сделки — заново при каждом входе в «Товары и оплата» (могли поменяться в портале или прошлой
  // бронью), пока сотрудник их не правил. Сбой — ошибка с повтором, а не «товаров нет»: иначе
  // добавленный товар заменил бы товары сделки.
  const [productsTry, setProductsTry] = useState(0);
  const onGoods = opened === 'goods';
  useEffect(() => {
    if (!existingDealId) return;
    let active = true;
    const key = `deal:${existingDealId}`;
    apiGet<DealProductRowDto[]>(`/deals/${existingDealId}/products`).then(
      (r) => active && setProducts((prev) => (prev?.key === key && prev.dirty ? prev : { key, rows: Array.isArray(r) ? r : [], dirty: false })),
      (e) =>
        active &&
        setProducts((prev) =>
          prev?.key === key && (prev.dirty || !prev.error) && prev.rows.length
            ? prev
            : { key, rows: [], dirty: false, error: e instanceof Error ? e.message : 'Не удалось загрузить товары сделки' },
        ),
    );
    return () => {
      active = false;
    };
  }, [existingDealId, onGoods, productsTry]);
  const names = new Map((list ?? []).map((r) => [r.id, r.name]));
  const nights =
    group?.bookingMode === 'interval' ? Math.max(1, Math.round((Date.parse(period.endDate) - Date.parse(period.startDate)) / 86_400_000) || 1) : 1;
  const defaultRows: ProductRow[] = cat
    ? resourceIds.flatMap((rid) =>
        (cat.defaults?.[String(rid)] ?? []).flatMap((dp) => {
          const p = cat.products?.find((x) => x.id === dp.productId);
          // В режиме «заезд/выезд» количество — по числу ночей (как в прототипе).
          return p
            ? [{ productId: p.id, name: p.name, price: p.price ?? 0, quantity: dp.quantity * nights, discountType: 'percent' as const, discount: 0, defaultFor: names.get(rid) }]
            : [];
        }),
      )
    : [];
  const loadedProducts = products?.key === productsKey ? products : null;
  // Существующая сделка без товаров — товары ресурса по умолчанию (запишутся в сделку при создании).
  const dealEmpty = deal.mode === 'existing' && !!loadedProducts && !loadedProducts.dirty && !loadedProducts.error && !loadedProducts.rows.length;
  const usesDefaults = deal.mode === 'new' ? !loadedProducts?.dirty : dealEmpty;
  const productRows = usesDefaults ? defaultRows : (loadedProducts?.rows ?? []);
  const productsLoading = deal.mode === 'existing' && !loadedProducts;
  const setProductRows = (rows: ProductRow[]) => {
    setProducts({ key: productsKey, rows, dirty: true });
    // Сумма сделки — по товарам (Битрикс24 пересчитает её из строк; форма — для формул, например 50%).
    if (createFields.some((f) => f.code === 'OPPORTUNITY' && !f.readOnly)) fieldState.set('OPPORTUNITY', String(productsTotal(rows)));
  };

  const roleField = (role: string) => createFields.find((f) => f.role === role && !f.readOnly);
  // Гости и комментарий менеджера есть среди полей группы — отдельные поля формы не нужны.
  const guestsField = roleField('guests');
  const commentField = roleField('managerComment');

  const chooseGroup = (id: string, manual = true) => {
    setGroupId(id);
    if (manual) setGroupManual(true);
    const g = allowed.find((x) => x.id === id);
    if (g) setPeriod(defaultPeriod(g, period.startDate, period.startTime));
    setResourceIds((prev) => prev.filter((r) => g?.resourceIds.includes(r)));
    // Другая группа — другие права: недоступный выбор сбрасывается.
    if (deal.mode === 'new' && !g?.permissions.includes('deal.create')) setDeal({ mode: 'service' });
    if (!PAYMENT_MODES.filter((m) => canUsePaymentMode(g?.permissions ?? [], m)).includes(paymentMode)) setPaymentMode('prepayment');
    setBookingTypeId('');
  };

  // Группы, где можно создать именно такую бронь (новая сделка — нужно право на сделки) — в порядке
  // из настроек (⚙ → «Группы»); группа воронки выбранной сделки помечается.
  const anyNewDeal = allowed.some((g) => g.permissions.includes('deal.create'));
  const chosenDeal = deal.mode === 'existing' ? deals.find((d) => d.id === deal.dealId) : undefined;
  const dealCategory = chosenDeal?.categoryId ?? null;
  const groupChoices = allowed.filter((g) => deal.mode !== 'new' || g.permissions.includes('deal.create'));
  const funnelGroup = dealCategory !== null ? groupChoices.find((g) => g.dealCategoryId === dealCategory) : undefined;

  // Оплата по типу сделки; без типа — как выбрал менеджер.
  const effectiveMode: PaymentMode =
    kindsOn && kind && kind !== 'certificate' ? (kind === 'by_certificate' ? (sendLink ? 'prepayment' : 'certificate') : DEAL_KIND_PAYMENT[kind]) : paymentMode;
  const typeRequired = !!group?.bookingTypeRequired || (kindsOn && (kind === 'visit' || kind === 'by_certificate') && (group?.bookingTypes ?? []).length > 0);
  const certificateMode = kindsOn && kind === 'certificate';

  // Занятость выбранных ресурсов на выбранное время.
  const startMs = Date.parse(zonedTimeToUtc(period.startDate, period.startTime || '00:00', timezone).toISOString());
  const endMs = Date.parse(zonedTimeToUtc(period.endDate, period.endTime || '00:00', timezone).toISOString());
  // Бронь в прошлом не нужна: предоплата и сверка ждут будущую (запас — 5 минут на заполнение формы).
  const now = useNow();
  const pastStart = isPastStart(startMs, now);
  const utc = periodToUtc(period, timezone);
  const states = resourceIds.map((rid) => ({
    rid,
    state: dayData && !dayLoading ? slotStateOf(rid, dayData.bookings, dayData.techWindows, startMs, endMs, dayData.stops ?? []) : { kind: 'free' as const },
  }));
  const resName = (rid: number) => names.get(rid) ?? 'Ресурс';
  const slotError =
    'error' in utc
      ? utc.error
      : pastStart
        ? PAST_START_ERROR
        : (states
            .map(({ rid, state }) =>
              state.kind === 'stop'
                ? `${resName(rid)} закрыт (стоп): ${state.stop.reason}`
                : state.kind === 'busy'
                  ? `${resName(rid)} занят ${state.bookings.map((b) => `${fmtTime(b.start, timezone)}–${fmtTime(b.end, timezone)}`).join(', ')}`
                  : null,
            )
            .find(Boolean) ?? null);
  // Тех. окно не запрещает бронь — только предупреждение (точное пересечение — в разделе и на проверке).
  const techHits = states.filter((x) => x.state.kind === 'tech').map((x) => x.rid);
  const techWindows = (dayData?.techWindows ?? []).filter((t) => techHits.includes(t.resourceId) && Date.parse(t.start) < endMs && Date.parse(t.end) > startMs);
  const techText = techWindows.length
    ? `Время пересекается с тех. окном: ${techWindows.map((t) => `${resName(t.resourceId)} ${fmtTime(t.start, timezone)}–${fmtTime(t.end, timezone)}`).join(', ')}. Бронь возможна — уборку придётся сократить.`
    : null;
  // «До 17:45» — сдвинуть конец к началу первого тех. окна.
  const techFixEnd = techWindows.length ? techWindows.reduce((m, t) => (Date.parse(t.start) < Date.parse(m) ? t.start : m), techWindows[0].start) : null;

  const certNominal = Number(cert.nominal.replace(',', '.').replace(/\s/g, ''));
  const certificateError = !(certNominal > 0) ? 'Укажите сумму сертификата' : !cert.holder.trim() ? 'Укажите, на чьё имя сертификат' : !cert.validUntil ? 'Укажите срок действия' : null;
  const goodsError =
    deal.mode === 'service' || deal.mode === 'none'
      ? null
      : !modes.includes(effectiveMode)
        ? `«${PAYMENT_MODE_LABELS[effectiveMode]}» — нет права в этой группе`
        : kindsOn && typeRequired && !bookingTypeId
          ? 'Выберите тип бронирования'
          : deal.mode === 'new' && group?.bookingTypeRequired && !bookingTypeId && !productRows.length
            ? 'Выберите тип брони или добавьте товары: у новой сделки ещё нет товаров'
            : kindsOn && kind === 'by_certificate' && sendLink && !(Number(prepayAmount.replace(',', '.')) > 0)
              ? 'Заполните «Сумму предоплаты» — по ней будет ссылка на оплату'
              : null;
  const noPrice = productRows.filter((r) => !r.price && cat?.products.find((p) => p.id === r.productId)?.price === null);
  const goodsWarning =
    deal.mode === 'existing' && loadedProducts?.error && !loadedProducts.dirty
      ? 'Товары сделки не загрузились — останутся как есть'
      : noPrice.length
        ? `Без цены: ${noPrice.map((r) => r.name).join(', ')}`
        : null;
  const values = fieldState.values;
  const missing = createFields.filter((f) => f.required && !f.readOnly && !values[f.code]?.trim());

  const snapshot: WizardSnapshot = {
    dealMode: deal.mode,
    dealFixed: !!context.dealId,
    dealBooked: !!chosenDeal && (chosenDeal.tone ?? (chosenDeal.booking ? 'booked' : 'empty')) === 'booked',
    groupOk: groupChoices.some((g) => g.id === groupId),
    groupGiven: allowed.length <= 1 || (!!context.groupId && (!context.dealId || !!context.resourceId)),
    kindMissing: kindsOn && !kind,
    certificate: certificateMode,
    resourceCount: resourceIds.length,
    slotError,
    slotWarning: techText ? 'тех. окно' : null,
    certificateError,
    goodsError,
    goodsWarning,
    missingFields: !formKey ? [] : !currentForm ? null : missing.map((f) => f.label),
    fieldsError: currentForm?.error || null,
  };
  // Первым — раздел по точке входа (пока сотрудник ничего не открывал сам).
  const [initial] = useState(() => firstSection(snapshot));
  const active: SectionKey = opened ?? initial;
  const sections = visibleSections(snapshot);
  const shownActive = sections.includes(active) ? active : sections[0];
  const view = (k: SectionKey): SectionView => sectionView(k, snapshot, touched, visited);
  const issues = allIssues(snapshot);
  const bodyRef = useRef<HTMLDivElement>(null);

  /** Открыть раздел: уходим с текущего (он «тронут» — пустое станет ошибкой). */
  const open = (k: SectionKey, opts: { force?: boolean } = {}) => {
    setError(null);
    if (k === shownActive) return;
    if (!opts.force && view(k).status === 'locked' && k !== 'review') return;
    // Сделку подтвердили — группа по воронке, если группу руками не меняли.
    if (shownActive === 'who' && !groupManual && funnelGroup && funnelGroup.id !== groupId) chooseGroup(funnelGroup.id, false);
    if (k === 'review') return goReview();
    if (k === 'fields' && needDecision) setAskFields('fields');
    leave(k);
  };
  const leave = (k: SectionKey) => {
    setTouched((t) => new Set(t).add(shownActive));
    setVisited((v) => new Set(v).add(k));
    setOpened(k);
    requestAnimationFrame(() => bodyRef.current?.querySelector(`[data-section="${k}"]`)?.scrollIntoView({ block: 'nearest' }));
  };
  /** «Проверить»: есть проблемы — раздел первой из них (всё пустое подсвечивается), иначе — проверка. */
  const goReview = () => {
    const all = new Set<SectionKey>(sections);
    if (issues.length) {
      setTouched(all);
      if (issues[0].key !== shownActive) {
        setVisited((v) => new Set(v).add(issues[0].key));
        setOpened(issues[0].key);
      }
      requestAnimationFrame(() => {
        const el = bodyRef.current?.querySelector<HTMLElement>('.df-field.invalid input, .df-field.invalid select, .df-field.invalid textarea, .df-field.invalid button');
        el?.focus();
      });
      return;
    }
    if (sections.includes('fields') && needDecision) return setAskFields('review');
    setTouched(all);
    setVisited((v) => new Set(v).add('review'));
    setOpened('review');
  };
  const goNext = () => {
    const next = nextSection(shownActive, snapshot);
    if (!next) return;
    open(next, { force: next !== 'review' });
  };

  const submit = async () => {
    if (busy) return;
    if (issues.length) return goReview();
    if (certificateMode) return sellCertificate();
    if ('error' in utc) return setError({ text: utc.error, section: 'slot' });
    const dealFields = Object.fromEntries(createFields.filter((f) => !f.readOnly).map((f) => [f.code, values[f.code] ?? '']));
    const commentText = (deal.mode !== 'service' && commentField ? (values[commentField.code] ?? '') : comment).trim();
    setBusy(true);
    setError(null);
    try {
      const r = await apiPost<CreateBookingResultDto>('/bookings', {
        idempotencyKey,
        groupId,
        kind: deal.mode === 'service' ? 'service' : 'client',
        resourceIds,
        start: utc.start,
        end: utc.end,
        dealId: deal.mode === 'existing' ? deal.dealId : null,
        newDeal:
          deal.mode === 'new'
            ? { title: newDealTitle(client.name, period.startDate, resourceIds.map((id) => names.get(id) ?? '').filter(Boolean)), contactId: client.contactId }
            : null,
        contactId: client.contactId,
        guests: !guestsField && guests ? Number(guests) : null,
        comment: commentText || undefined,
        paymentMode: effectiveMode,
        bookingTypeId: deal.mode === 'service' ? null : bookingTypeId || null,
        ...(kindsOn && kind && kind !== 'certificate' ? { dealKind: kind } : {}),
        ...(kindsOn && kind === 'by_certificate' && sendLink ? { prepaymentAmount: Number(prepayAmount.replace(',', '.')) } : {}),
        ...(deal.mode === 'service' ? {} : { dealFields }),
        // Товары — если их меняли (или подставлены товары по умолчанию): строки сделки заменяются.
        ...(deal.mode !== 'service' && (loadedProducts?.dirty || (usesDefaults && productRows.length))
          ? {
              products: productRows
                .filter((r) => r.quantity > 0)
                .map((r) => ({ productId: r.productId, quantity: r.quantity, price: r.price, discountType: r.discountType, discount: r.discount })),
            }
          : {}),
      });
      const mode = deal.mode === 'service' ? null : effectiveMode;
      const done: WizardResult = {
        booking: r,
        dealId: r.dealId,
        payment: mode === 'prepayment' && r.dealId ? { amount: kind === 'by_certificate' ? Number(prepayAmount.replace(',', '.')) || null : null, fixedDeal: false } : null,
        note: `Бронь #${r.bookingId} создана${r.dealId ? ` в сделке #${r.dealId}` : ''}.${r.warnings.length ? ` ${r.warnings.join(' ')}` : ''}`,
      };
      // Частичный сбой (бронь есть, поля или товары — нет) — экран результата, иначе сразу дальше.
      if (r.warnings.length) setResult({ r: done, warnings: r.warnings });
      else onDone(done);
    } catch (e) {
      const text = e instanceof Error ? e.message : 'Не удалось создать бронь';
      setError({ text, section: errorSection(text) });
    } finally {
      setBusy(false);
    }
  };

  /** «Покупка сертификата»: сделка + сертификат, затем окно оплаты на весь номинал. */
  const sellCertificate = async () => {
    if (busy) return;
    if (deal.mode !== 'existing' && deal.mode !== 'new') return setError({ text: 'Выберите сделку или «Новая сделка»', section: 'who' });
    setBusy(true);
    setError(null);
    try {
      const r = await apiPost<SellCertificateResultDto>('/certificates/sale', {
        idempotencyKey,
        groupId,
        dealId: deal.mode === 'existing' ? deal.dealId : null,
        newDeal: deal.mode === 'new' ? { title: newDealTitle(client.name, todayIn(timezone), ['сертификат']), contactId: client.contactId } : null,
        nominal: certNominal,
        kind: cert.kind,
        holderName: cert.holder.trim(),
        validUntil: cert.validUntil,
      });
      onDone({
        booking: null,
        dealId: r.dealId,
        payment: { amount: null, fixedDeal: true },
        note: `Сертификат №${r.certificate.number} на ${fmtMoney(r.certificate.nominal, 'RUB')} оформлен в сделке #${r.dealId}.${r.warnings.length ? ` ${r.warnings.join(' ')}` : ''}`,
      });
    } catch (e) {
      setError({ text: e instanceof Error ? e.message : 'Не удалось оформить сертификат', section: null });
    } finally {
      setBusy(false);
    }
  };

  const pick = (d: DealChoice) => {
    setDeal(d);
    setError(null);
  };
  // Сделки клиента: последняя открытая видна сразу, остальные — по «Показать ещё».
  const dealCards: DealCard[] = [...(context.dealId && !deals.some((d) => d.id === context.dealId) ? [{ id: context.dealId, title: 'Эта сделка' }] : []), ...deals];
  const selectedId = deal.mode === 'existing' ? deal.dealId : null;
  const visibleDeals = dealCards.filter((d, i) => i < dealsShown || d.id === selectedId);
  const hiddenCount = dealCards.length - visibleDeals.length;

  // Выбран клиент поиском — его сделки (последняя открытая — первой); нет открытых — новая сделка.
  const chooseContact = async (c: CrmContactHit) => {
    setClient({ contactId: c.id, name: c.name });
    setClientCard(c);
    setSearching(false);
    setDealsShown(DEALS_STEP);
    try {
      const r = await apiGet<CrmSearchDto>(`/crm/search?contactId=${c.id}`);
      setDealList(r.deals.map(toCard));
      const openDeal = r.deals.find((d) => !d.closed);
      pick(openDeal ? { mode: 'existing', dealId: openDeal.id } : anyNewDeal ? { mode: 'new' } : { mode: 'service' });
    } catch (e) {
      setError({ text: e instanceof Error ? e.message : 'Не удалось загрузить сделки клиента', section: 'who' });
    }
  };
  const chooseDeal = (d: CrmDealHit) => {
    setDealList((prev) => [toCard(d), ...prev.filter((x) => x.id !== d.id)]);
    if (d.contact) setClient({ contactId: d.contact.id, name: d.contact.name });
    setSearching(false);
    pick({ mode: 'existing', dealId: d.id });
  };
  const resetClient = () => {
    setClient({ contactId: null, name: null });
    setDealList([]);
    setSearching(false);
    setDeal({ mode: 'none' });
  };

  // ── Сводки свёрнутых разделов ──
  const dealLabel =
    deal.mode === 'none'
      ? null
      : deal.mode === 'service'
        ? 'Служебная (без сделки)'
        : deal.mode === 'new'
          ? 'новая сделка'
          : chosenDeal
            ? `#${chosenDeal.id} «${chosenDeal.title}»`
            : `#${deal.dealId}`;
  const resourcesText = resourceIds.map((id) => names.get(id)).filter(Boolean).join(', ');
  const whenText =
    group?.bookingMode === 'interval'
      ? `${period.startDate.slice(8, 10)}.${period.startDate.slice(5, 7)} ${period.startTime} → ${period.endDate.slice(8, 10)}.${period.endDate.slice(5, 7)} ${period.endTime} · ${nightsText(nights)}`
      : `${period.startTime}–${period.endDate !== period.startDate ? `${period.endDate.slice(8, 10)}.${period.endDate.slice(5, 7)} ` : ''}${period.endTime}${'error' in utc ? '' : ` · ${durationText(Date.parse(utc.end) - Date.parse(utc.start))}`}`;
  const total = productsTotal(productRows);
  const typeTitle = (group?.bookingTypes ?? []).find((t) => t.id === bookingTypeId)?.title;
  const editableFields = createFields.filter((f) => !f.readOnly);
  const filledCount = editableFields.filter((f) => values[f.code]?.trim()).length;
  const summaries: Record<SectionKey, ReactNode> = {
    who: deal.mode === 'none' ? null : (
      <>
        {[client.name, dealLabel].filter(Boolean).join(' · ')}
        {chosenDeal && (
          <span className={`cx-tone tone-${toneOf(chosenDeal)}`}>
            <i aria-hidden="true" /> {TONE_WORDS[toneOf(chosenDeal)]}
          </span>
        )}
      </>
    ),
    when: group ? [group.name, kindsOn && kind ? DEAL_KIND_LABELS[kind] : null, dayShort(period.startDate)].filter(Boolean).join(' · ') : null,
    slot: resourceIds.length ? `${resourcesText || 'Ресурс'} · ${whenText}` : null,
    certificate: certNominal > 0 ? [fmtMoney(certNominal, 'RUB'), CERTIFICATE_KIND_LABELS[cert.kind].toLowerCase(), cert.holder && `на ${cert.holder}`, cert.validUntil && `до ${fmtDate(`${cert.validUntil}T12:00:00Z`, 'UTC')}`].filter(Boolean).join(' · ') : null,
    goods: visited.has('goods') || productRows.length
      ? [`${productRows.length} поз.`, fmtMoney(total, 'RUB'), PAYMENT_MODE_LABELS[effectiveMode], typeTitle ? `«${typeTitle}»` : null].filter(Boolean).join(' · ')
      : resourceIds.length ? null : 'Подставим товары ресурса после выбора времени',
    fields: !currentForm
      ? null
      : missing.length && touched.has('fields')
        ? null
        : visited.has('fields')
          ? `Заполнено ${filledCount} из ${editableFields.length}${decided.key === formKey && decided.cleared ? ` · очищено ${decided.cleared}` : ''}`
          : `Не заполнено · обязательных: ${editableFields.filter((f) => f.required).length}`,
    comment: comment.trim() ? comment.trim().slice(0, 80) : visited.has('comment') ? 'Без комментария' : null,
    review: null,
  };

  // ── Разделы ──
  const dealCardButton = (d: DealCard, meta: string) => (
    <button
      key={d.id}
      type="button"
      role="radio"
      aria-checked={selectedId === d.id}
      className={`bk-choice wz-deal tone-${toneOf(d)}${selectedId === d.id ? ' selected' : ''}`}
      title={DEAL_TONE_TITLES[toneOf(d)]}
      onClick={() => {
        pick({ mode: 'existing', dealId: d.id });
        if (d.client !== undefined) setClient((c) => (c.contactId ? c : { contactId: null, name: d.client ?? null }));
      }}
    >
      <span className="bk-dot" aria-hidden="true" />
      <span className="wz-deal-main">
        <b>{d.title}</b>
        <span className="wz-deal-sub">
          {[d.client, d.opportunity ? fmtMoney(d.opportunity, 'RUB') : null, `#${d.id}${meta}`, d.createdAt ? `от ${fmtDate(d.createdAt, timezone)}` : null]
            .filter(Boolean)
            .join(' · ')}
        </span>
        {d.booking && (
          <span className="wz-deal-booking">
            Бронь: {fmtDateTime(d.booking.start, timezone)}
            {d.booking.resources.length ? ` · ${d.booking.resources.join(', ')}` : ''}
          </span>
        )}
        <DealModifier by={d.modifiedBy} />
      </span>
    </button>
  );

  const whoSection = (
    <>
      {client.contactId || client.name || dealList.length ? (
        <>
          <div className="bk-client">
            {client.contactId ? (
              <button type="button" className="bk-client-card" title="Открыть карточку клиента в Битрикс24" onClick={() => openCrm('contact', client.contactId!)}>
                <Avatar src={card?.photo} name={card?.name ?? client.name ?? '?'} size={36} />
                <ContactName name={card?.name ?? client.name ?? `Контакт #${client.contactId}`} id={client.contactId} />
              </button>
            ) : (
              <span className="bk-client-card static">
                <Avatar name={client.name ?? '?'} size={36} />
                <b>{client.name}</b>
              </span>
            )}
            {!context.contactId && (
              <>
                <button type="button" className="bk-more" aria-expanded={searching} onClick={() => setSearching(!searching)}>
                  Изменить
                </button>
                <button type="button" className="bk-more" onClick={resetClient}>
                  Сбросить
                </button>
              </>
            )}
          </div>
          {searching && <ClientPicker onContact={(c) => void chooseContact(c)} onDeal={chooseDeal} autoFocus />}
          <h4 className="bk-title wz-deals-title">
            Сделка{dealCards.length ? ` · ${dealCards.length} ${dealCards.length === 1 ? 'открытая' : 'открытые'}` : ''} <ToneLegend />
          </h4>
          <div className="bk-choices wz-deals" role="radiogroup" aria-label="Сделка">
            {visibleDeals.map((d) => dealCardButton(d, d.id === context.dealId ? ' · открыта сейчас' : d.closed ? ' · закрыта' : ''))}
            {!dealCards.length && <p className="cp-hint">У клиента нет открытых сделок — создайте новую.</p>}
          </div>
          {hiddenCount > 0 && (
            <button type="button" className="bk-more wz-deals-more" onClick={() => setDealsShown((n) => n + DEALS_STEP)}>
              Показать ещё {Math.min(DEALS_STEP, hiddenCount)} из {hiddenCount}
            </button>
          )}
        </>
      ) : (
        <>
          <ClientPicker onContact={(c) => void chooseContact(c)} onDeal={chooseDeal} autoFocus />
          <h4 className="bk-title wz-deals-title">
            Последняя активность <ToneLegend />
          </h4>
          {!recent.deals && <p className="cp-hint">Загрузка сделок…</p>}
          {recent.error && <p className="cp-hint error">{recent.error}</p>}
          {recent.deals && !recent.deals.length && !recent.error && <p className="cp-hint">Открытых сделок нет.</p>}
          <div className="bk-choices wz-recent" role="radiogroup" aria-label="Сделки с последней активностью">
            {recent.deals?.map((d) => (
              <button
                key={d.id}
                type="button"
                role="radio"
                aria-checked={selectedId === d.id}
                className={`bk-choice wz-deal tone-${d.tone ?? 'empty'}${selectedId === d.id ? ' selected' : ''}`}
                title={DEAL_TONE_TITLES[d.tone ?? 'empty']}
                onClick={() => chooseDeal(d)}
              >
                <span className="bk-dot" aria-hidden="true" />
                <span className="wz-deal-main">
                  <b>{d.title}</b>
                  <span className="wz-deal-sub">{[d.contact?.name, d.opportunity ? fmtMoney(d.opportunity, d.currency) : null, `#${d.id}`].filter(Boolean).join(' · ')}</span>
                  <DealModifier by={d.modifiedBy} />
                </span>
                {d.lastActivityAt && <span className="wz-ago">{agoText(d.lastActivityAt)}</span>}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="bk-choices wz-other">
        {anyNewDeal && (
          // Выбор — как карточка сделки; название соберётся при создании (клиент, дата брони, ресурс).
          <button
            type="button"
            role="radio"
            aria-checked={deal.mode === 'new'}
            className={`bk-choice bk-add-deal${deal.mode === 'new' ? ' selected' : ''}`}
            title="Название: имя клиента, дата брони и ресурс"
            onClick={() => pick({ mode: 'new' })}
          >
            <span className="bk-dot" aria-hidden="true" />
            <span className="wz-deal-main">
              <b>＋ {client.contactId ? 'Новая сделка для клиента' : 'Новая сделка'}</b>
              <span className="wz-deal-sub">название — имя клиента, дата брони и ресурс</span>
            </span>
          </button>
        )}
        <button
          type="button"
          role="radio"
          aria-checked={deal.mode === 'service'}
          className={`bk-choice cx-service${deal.mode === 'service' ? ' selected' : ''}`}
          onClick={() => pick({ mode: 'service' })}
        >
          <span className="bk-dot" aria-hidden="true" />
          <span className="wz-deal-main">
            <b>Служебная бронь</b>
            <span className="wz-deal-sub">без сделки: уборка, ремонт, свои</span>
          </span>
        </button>
      </div>
      {snapshot.dealBooked && <p className="notice warning">По этой сделке уже есть бронь — вторая бронь, скорее всего, нужна в другой сделке.</p>}
    </>
  );

  const whenSection = (
    <>
      {groupChoices.length > 1 ? (
        <div className="wz-groups" role="radiogroup" aria-label="Группа">
          {groupChoices.map((g) => (
            <button key={g.id} type="button" role="radio" aria-checked={g.id === groupId} className={`wz-group${g.id === groupId ? ' selected' : ''}`} onClick={() => chooseGroup(g.id)}>
              <b>{g.name}</b>
              <span className="muted">
                ресурсов: {g.resourceIds.length}
                {dealCategory !== null && g.dealCategoryId === dealCategory ? ' · воронка сделки' : ''}
              </span>
            </button>
          ))}
        </div>
      ) : (
        group && (
          <p className="cx-line">
            Группа: <b>{group.name}</b>
          </p>
        )
      )}
      {!groupChoices.length && <p className="notice error">Нет групп, где вам можно создать такую бронь.</p>}
      {groupManual && funnelGroup && funnelGroup.id !== groupId && (
        <p className="cp-hint">
          Воронка сделки — группа «{funnelGroup.name}».{' '}
          <button type="button" className="link" onClick={() => chooseGroup(funnelGroup.id)}>
            Выбрать её
          </button>
        </p>
      )}
      {kindsOn && (
        <>
          <h4 className="cx-subtitle">Тип сделки</h4>
          <div className="wz-groups wz-kinds" role="radiogroup" aria-label="Тип сделки">
            {DEAL_KINDS.map((k) => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} className={`wz-group${kind === k ? ' selected' : ''}`} onClick={() => setKind(k)}>
                <b>{DEAL_KIND_LABELS[k]}</b>
                <span className="muted">{DEAL_KIND_HINTS[k]}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {!certificateMode && group && (
        <>
          <h4 className="cx-subtitle">{group.bookingMode === 'interval' ? 'Дата заезда' : 'Дата'}</h4>
          <DayStrip date={period.startDate} onDate={(d) => setPeriod(defaultPeriod(group, d, period.startTime))} />
        </>
      )}
    </>
  );

  const slotSection = group ? (
    <>
      <SlotPicker
        compact={callPlacement}
        hideDays={!callPlacement}
        group={group}
        timezone={timezone}
        period={period}
        onPeriod={setPeriod}
        days={dayData ?? day?.data ?? null}
        loading={dayLoading}
        resourceIds={resourceIds}
        onResources={setResourceIds}
      />
      {techText && (
        <div className="notice warning cx-warn">
          <span>⚠ {techText}</span>
          {techFixEnd && Date.parse(techFixEnd) > startMs && (
            <button
              type="button"
              onClick={() =>
                setPeriod({ ...period, endDate: new Intl.DateTimeFormat('sv-SE', { timeZone: timezone }).format(new Date(techFixEnd)), endTime: fmtTime(techFixEnd, timezone) })
              }
            >
              До {fmtTime(techFixEnd, timezone)}
            </button>
          )}
        </div>
      )}
    </>
  ) : null;

  const certificateSection = (
    <>
      <div className="df-grid">
        <div className="df-row pair">
          <label className="df-field">
            <span className="df-label">
              Сумма сертификата, ₽<i className="df-req">*</i>
            </span>
            <input inputMode="decimal" autoFocus value={cert.nominal} placeholder="10 000" onChange={(e) => setCert({ ...cert, nominal: e.target.value })} />
          </label>
          <div className="df-field">
            <span className="df-label">Тип сертификата</span>
            <span className="segmented" role="radiogroup" aria-label="Тип сертификата">
              {CERTIFICATE_KINDS.map((k) => (
                <button key={k} type="button" role="radio" aria-checked={cert.kind === k} className={cert.kind === k ? 'active' : ''} onClick={() => setCert({ ...cert, kind: k })}>
                  {CERTIFICATE_KIND_LABELS[k]}
                </button>
              ))}
            </span>
          </div>
        </div>
        <div className="df-row pair">
          <label className="df-field">
            <span className="df-label">
              На чьё имя<i className="df-req">*</i>
            </span>
            <input value={cert.holder} maxLength={255} placeholder="Имя и фамилия" onChange={(e) => setCert({ ...cert, holder: e.target.value })} />
          </label>
          <label className="df-field">
            <span className="df-label">Действителен до</span>
            <input type="date" value={cert.validUntil} min={todayIn(timezone)} onChange={(e) => setCert({ ...cert, validUntil: e.target.value })} />
          </label>
        </div>
      </div>
      <p className="cp-hint">
        Сделка получит тип «Покупка сертификата» и сумму, сертификат появится в 🎟 «Сертификаты» (не оплачен). Дальше — ссылка на оплату всей суммы.
      </p>
    </>
  );

  const goodsSection = (
    <>
      {dealEmpty && defaultRows.length > 0 && (
        <p className="notice info">
          В сделке #{existingDealId} товаров нет — подставили товары по умолчанию для <b>{[...new Set(defaultRows.map((r) => r.defaultFor).filter(Boolean))].join(', ')}</b>. При создании брони они запишутся в сделку.
        </p>
      )}
      {deal.mode === 'existing' && !dealEmpty && !productsLoading && !loadedProducts?.error && <p className="cx-line muted">Изменения заменят товары сделки #{existingDealId}.</p>}
      <ProductsEditor
        catalog={cat}
        rows={productRows}
        onChange={setProductRows}
        loading={productsLoading}
        error={deal.mode === 'existing' && !loadedProducts?.dirty ? loadedProducts?.error : undefined}
        onRetry={() => {
          setProducts(null);
          setProductsTry((n) => n + 1);
        }}
      />
      <h4 className="cx-subtitle">Бронь и оплата</h4>
      <div className="df-grid">
        {group && (group.bookingTypes ?? []).length > 0 && (
          <div className={`df-field${goodsError === 'Выберите тип бронирования' && touched.has('goods') ? ' invalid' : ''}`}>
            <span className="df-label">
              Тип брони{typeRequired && <i className="df-req">*</i>}
            </span>
            {/* Тип брони карточками; недоступный (Теремок) виден, но не выбирается. Не обязателен — «По товарам». */}
            <span className="wz-types" role="radiogroup" aria-label="Тип брони">
              {!typeRequired && (
                <button type="button" role="radio" aria-checked={!bookingTypeId} className={`wz-type${!bookingTypeId ? ' selected' : ''}`} onClick={() => setBookingTypeId('')}>
                  По товарам сделки
                </button>
              )}
              {(group.bookingTypes ?? []).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={bookingTypeId === t.id}
                  disabled={t.unavailable}
                  title={t.unavailable ? 'Сейчас недоступен для бронирования' : undefined}
                  className={`wz-type${bookingTypeId === t.id ? ' selected' : ''}`}
                  onClick={() => setBookingTypeId(bookingTypeId === t.id && !typeRequired ? '' : t.id)}
                >
                  {t.title}
                  {t.unavailable && <small> · недоступен</small>}
                </button>
              ))}
            </span>
          </div>
        )}
        <div className={`df-row${guestsField ? '' : ' pair'}`}>
          <div className="df-field">
            <span className="df-label">Способ оплаты</span>
            {kindsOn && kind ? (
              <span className="wz-pay-mode">{PAYMENT_MODE_LABELS[effectiveMode]}</span>
            ) : (
              <span className="wz-types" role="radiogroup" aria-label="Способ оплаты">
                {modes.map((m) => (
                  <button key={m} type="button" role="radio" aria-checked={paymentMode === m} className={`wz-type${paymentMode === m ? ' selected' : ''}`} onClick={() => setPaymentMode(m)}>
                    {PAYMENT_MODE_LABELS[m]}
                  </button>
                ))}
              </span>
            )}
          </div>
          {!guestsField && (
            <label className="df-field">
              <span className="df-label">Гостей</span>
              <input type="number" min={0} max={1000} value={guests} onChange={(e) => setGuests(e.target.value)} />
            </label>
          )}
        </div>
        {kindsOn && kind === 'by_certificate' && (
          <div className="wz-link-choice">
            <label className="wz-check">
              <input type="checkbox" checked={sendLink} onChange={(e) => setSendLink(e.target.checked)} />
              Отправить клиенту ссылку на оплату (доплата сверх сертификата)
            </label>
            {sendLink && (
              <label className="df-field">
                <span className="df-label">
                  Сумма предоплаты, ₽<i className="df-req">*</i>
                </span>
                <input inputMode="decimal" value={prepayAmount} placeholder="заполните перед отправкой ссылки" onChange={(e) => setPrepayAmount(e.target.value)} />
                {!prepayAmount && <span className="cp-hint error">В сделке «Сумма предоплаты» не заполнена — укажите её, она уйдёт в ссылку.</span>}
              </label>
            )}
          </div>
        )}
      </div>
    </>
  );

  // Пустое обязательное поле подсвечивается после ухода с раздела, потери фокуса или «Проверить».
  const fieldErrors = new Set(missing.filter((f) => touched.has('fields') || blurred.has(f.code)).map((f) => f.code));
  const fieldsSection = (
    <>
      {!currentForm && <p className="bk-loading">Загрузка полей сделки…</p>}
      {currentForm?.error && <p className="notice error">{currentForm.error}</p>}
      {createFields.length > 0 && (
        <DealFieldsEditor
          fields={createFields}
          values={values}
          auto={fieldState.auto}
          onChange={fieldState.set}
          onResetFormula={fieldState.resetFormula}
          errors={fieldErrors}
          onBlurField={(code) => setBlurred((b) => (b.has(code) ? b : new Set(b).add(code)))}
          compactReadOnly
          bookingDate={period.startDate}
          override={(f) =>
            f.code === 'OPPORTUNITY' && !f.readOnly ? (
              <span className="df-from-goods">
                <b>{fmtMoney(total, 'RUB')}</b> <span className="muted">из товаров</span>
                <button type="button" className="link" onClick={() => open('goods')}>
                  Товары →
                </button>
              </span>
            ) : null
          }
        />
      )}
      {currentForm && !createFields.length && <p className="cp-hint">У группы нет полей сделки для формы брони.</p>}
      {!commentField && (
        <label className="df-field cx-comment">
          <span className="df-label">Комментарий</span>
          <textarea rows={2} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />
        </label>
      )}
    </>
  );

  const commentSection = (
    <label className="df-field">
      <span className="df-label">Комментарий</span>
      <textarea rows={3} maxLength={2000} autoFocus value={comment} placeholder="Например: уборка после ремонта" onChange={(e) => setComment(e.target.value)} />
    </label>
  );

  // Проверка: «чек» только для чтения.
  const gross = productRows.reduce((s, r) => s + r.price * r.quantity, 0);
  const shownFields = editableFields.filter((f) => values[f.code]?.trim() && f.code !== 'OPPORTUNITY');
  const fieldText = (f: DealFormField) => {
    const v = values[f.code] ?? '';
    if (f.kind === 'enum') return f.items?.find((i) => i.id === v)?.value ?? v;
    if (f.kind === 'boolean') return v === 'Y' ? 'Да' : v === 'N' ? 'Нет' : v;
    if (f.kind === 'money') return fmtMoney(Number(v.replace(',', '.')) || 0, 'RUB');
    if (f.kind === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v.slice(8, 10)}.${v.slice(5, 7)}.${v.slice(0, 4)}`;
    return v;
  };
  const warnings: { text: string; section: SectionKey }[] = [
    techText ? { text: techText, section: 'slot' as const } : null,
    snapshot.dealBooked ? { text: 'По этой сделке уже есть бронь.', section: 'who' as const } : null,
    deal.mode !== 'service' && !certificateMode && !bookingTypeId && (group?.bookingTypes ?? []).length > 0 && !productRows.length
      ? { text: 'Тип брони не определится: не выбран и товаров нет.', section: 'goods' as const }
      : null,
    goodsWarning ? { text: goodsWarning, section: 'goods' as const } : null,
  ].flatMap((w) => (w ? [w] : []));
  const row = (label: string, section: SectionKey, body: ReactNode) => (
    <div className="cx-check-row">
      <span className="cx-check-label">{label}</span>
      <span className="cx-check-value">{body}</span>
      <button type="button" className="link" onClick={() => open(section)}>
        Изменить
      </button>
    </div>
  );
  const reviewSection = (
    <>
      <div className="cx-check">
        {row('Клиент', 'who', <b>{client.name ?? '—'}</b>)}
        {row('Сделка', 'who', [dealLabel, kindsOn && kind ? DEAL_KIND_LABELS[kind] : null].filter(Boolean).join(' · '))}
        {row('Группа', 'when', group?.name ?? '—')}
        {certificateMode
          ? row('Сертификат', 'certificate', summaries.certificate)
          : row(
              'Ресурс и время',
              'slot',
              <>
                <b>{resourcesText}</b> · {dayShort(period.startDate)}, <b>{whenText}</b>
              </>,
            )}
        {sections.includes('goods') &&
          row(
            'Товары',
            'goods',
            productRows.length ? (
              <span className="cx-check-goods">
                {productRows.map((r, i) => (
                  <span key={i} className="cx-check-line">
                    <span>
                      {r.name}{' '}
                      <span className="muted">
                        {r.quantity} × {fmtMoney(r.price, 'RUB')}
                        {r.discount ? ` − ${r.discountType === 'percent' ? `${r.discount}%` : fmtMoney(r.discount, 'RUB')}` : ''}
                      </span>
                    </span>
                    <span>{fmtMoney(rowTotal(r), 'RUB')}</span>
                  </span>
                ))}
                {gross !== total && (
                  <span className="cx-check-line muted">
                    <span>Скидка</span>
                    <span>−{fmtMoney(gross - total, 'RUB')}</span>
                  </span>
                )}
                <span className="cx-check-line cx-check-total">
                  <b>Итого</b>
                  <b>{fmtMoney(total, 'RUB')}</b>
                </span>
              </span>
            ) : (
              <span className="muted">{deal.mode === 'existing' && !loadedProducts?.dirty ? 'Товары сделки не меняются' : 'Без товаров'}</span>
            ),
          )}
        {sections.includes('goods') &&
          row(
            'Оплата',
            'goods',
            [PAYMENT_MODE_LABELS[effectiveMode], typeTitle ? `тип брони «${typeTitle}»` : null, !guestsField && guests ? `гостей: ${guests}` : null].filter(Boolean).join(' · '),
          )}
        {sections.includes('fields') &&
          row(
            'Поля сделки',
            'fields',
            shownFields.length ? (
              <span className="cx-check-fields">
                {shownFields.map((f) => (
                  <span key={f.code}>
                    <span className="muted">{f.label}:</span> {f.required ? <b>{fieldText(f)}</b> : fieldText(f)}
                  </span>
                ))}
              </span>
            ) : (
              <span className="muted">Не заполнены</span>
            ),
          )}
        {(sections.includes('comment') || (!commentField && comment.trim())) && row('Комментарий', sections.includes('comment') ? 'comment' : 'fields', comment.trim() || <span className="muted">—</span>)}
      </div>
      {warnings.map((w) => (
        <div key={w.text} className="notice warning cx-warn">
          <span>⚠ {w.text}</span>
          <button type="button" onClick={() => open(w.section)}>
            Изменить
          </button>
        </div>
      ))}
    </>
  );

  const bodies: Record<SectionKey, ReactNode> = {
    who: whoSection,
    when: whenSection,
    slot: slotSection,
    certificate: certificateSection,
    goods: goodsSection,
    fields: fieldsSection,
    comment: commentSection,
    review: reviewSection,
  };
  const hints: Partial<Record<SectionKey, string>> = {
    who: context.dealId ? 'сделка из встройки' : context.contactId ? 'клиент известен' : undefined,
    slot: group ? (group.bookingMode === 'interval' ? 'заезд / выезд' : 'часы от клика') : undefined,
    goods: usesDefaults && defaultRows.length ? `по умолчанию · ${[...new Set(defaultRows.map((r) => r.defaultFor).filter(Boolean))].join(', ')}` : undefined,
    fields: createFields.length ? `обязательных: ${editableFields.filter((f) => f.required).length}${missing.length ? ` · не заполнено ${missing.length}` : ''}` : undefined,
    review: 'только чтение',
  };

  const isLast = shownActive === 'review';
  const beforeReview = nextSection(shownActive, snapshot) === 'review';
  const fieldsBadge = sections.includes('fields') && touched.has('fields') && missing.length > 0;
  const mainLabel = isLast
    ? busy
      ? certificateMode
        ? 'Оформляем…'
        : 'Создаём…'
      : certificateMode
        ? 'Оформить сертификат'
        : 'Создать бронь'
    : beforeReview
      ? 'Проверить'
      : 'Далее';

  if (result)
    return (
      <div className={`sheet-backdrop${callPlacement ? ' call-booking-backdrop' : ''}`}>
        <div className="sheet bk wz cx" role="dialog" aria-modal="true" aria-label="Бронь создана">
          <div className="cx-result">
            <div className="cx-result-icon" aria-hidden="true">
              ✓
            </div>
            <h3>Бронь #{result.r.booking?.bookingId} создана</h3>
            <p className="muted">{result.r.dealId ? `Сделка #${result.r.dealId}` : 'Служебная бронь'}</p>
            {result.warnings.map((w) => (
              <p key={w} className="notice warning">
                ⚠ {w}
              </p>
            ))}
            <div className="cx-result-actions">
              {result.r.dealId && (
                <button type="button" onClick={() => openCrm('deal', result.r.dealId!)}>
                  Открыть сделку
                </button>
              )}
              {result.r.payment && (
                <button type="button" onClick={() => onDone(result.r)}>
                  Перейти к предоплате
                </button>
              )}
              <button type="button" className="primary" onClick={() => onDone({ ...result.r, payment: null })}>
                Готово
              </button>
            </div>
          </div>
        </div>
      </div>
    );

  return (
    <div className={`sheet-backdrop${callPlacement ? ' call-booking-backdrop' : ''}`} onClick={() => !busy && onClose()}>
      <form
        className={`sheet bk wz cx${callPlacement ? ' cx-call' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Новая бронь"
        noValidate
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (isLast) void submit();
          else if (beforeReview) goReview();
          else goNext();
        }}
      >
        <header className="bk-head">
          <div>
            <h3>
              Новая бронь
              <span className="cx-head-sub">{[group?.name, client.name].filter(Boolean).map((t) => ` · ${t}`).join('')}</span>
            </h3>
          </div>
          <MinimizeButton label="Новая бронь" />
          <button type="button" className="bk-close" aria-label="Закрыть" disabled={busy} onClick={onClose}>
            ×
          </button>
        </header>
        <div className="bk-body cx-body" ref={bodyRef} tabIndex={callPlacement ? 0 : undefined} aria-label={callPlacement ? 'Разделы бронирования' : undefined}>
          {!allowed.length ? (
            <p className="notice error">Нет права создавать брони ни в одной группе.</p>
          ) : (
            sections.map((k, i) => {
              const v = view(k);
              const isOpen = k === shownActive;
              // Сделка из встройки не меняется.
              const fixed = k === 'who' && !!context.dealId;
              if (isOpen)
                return (
                  <section key={k} data-section={k} className="cx-sec open" aria-labelledby={`cx-${k}`}>
                    <header className="cx-sec-head">
                      <span className="cx-num" aria-hidden="true">
                        {i + 1}
                      </span>
                      <h4 id={`cx-${k}`}>{SECTION_TITLES[k]}</h4>
                      {hints[k] && <span className={`cx-hint${k === 'fields' && missing.length && touched.has('fields') ? ' bad' : ''}`}>{hints[k]}</span>}
                    </header>
                    <div className="cx-sec-body">{bodies[k]}</div>
                    {!isLast && (
                      <footer className="cx-sec-foot">
                        <span className={error?.section === k || (v.status === 'error' && v.note) ? 'cx-foot-error' : 'muted'}>
                          {error?.section === k ? error.text : v.status === 'error' && v.note ? v.note : 'Изменения применяются сразу'}
                        </span>
                        <button type="button" className="cx-next" disabled={busy} onClick={beforeReview ? goReview : goNext}>
                          {beforeReview ? 'К проверке →' : 'Далее →'}
                        </button>
                      </footer>
                    )}
                  </section>
                );
              const locked = v.status === 'locked';
              return (
                <button
                  key={k}
                  type="button"
                  data-section={k}
                  className={`cx-row ${v.status}${fixed ? ' fixed' : ''}`}
                  disabled={busy || locked || fixed}
                  onClick={() => open(k)}
                  title={fixed ? 'Сделка, из которой открыта бронь' : undefined}
                >
                  <span className="cx-icon" aria-hidden="true">
                    {locked ? '🔒' : v.status === 'done' ? '✓' : v.status === 'warning' ? '⚠' : v.status === 'error' ? '!' : ''}
                  </span>
                  <span className="cx-row-title">{SECTION_TITLES[k]}</span>
                  <span className="cx-row-summary">
                    {locked ? (
                      v.note
                    ) : v.status === 'error' ? (
                      <span className="cx-bad">{v.note}</span>
                    ) : (
                      <>
                        {summaries[k] ?? <span className="muted">Не выбрано</span>}
                        {v.status === 'warning' && v.note && <i className="cx-badge">{v.note}</i>}
                      </>
                    )}
                  </span>
                  {!locked && !fixed && <span className="cx-change">Изменить</span>}
                </button>
              );
            })
          )}
          {error && !error.section && !callPlacement && (
            <p className="notice error" role="alert">
              {error.text}
            </p>
          )}
        </div>
        {allowed.length > 0 && (
          <footer className="bk-foot">
            <span className="bk-summary">
              {[resourceIds.length ? resourcesText : null, resourceIds.length && !certificateMode ? `${dayShort(period.startDate)}, ${period.startTime}–${period.endTime}` : null]
                .filter(Boolean)
                .join(' · ') || [client.name, dealLabel ?? 'сделка не выбрана'].filter(Boolean).join(' · ')}
              {total > 0 && sections.includes('goods') && <b className="cx-total"> · {fmtMoney(total, 'RUB')}</b>}
              {fieldsBadge && (
                <button type="button" className="cx-badge bad" onClick={() => open('fields')}>
                  ! {missing.length} {missing.length === 1 ? 'поле' : missing.length < 5 ? 'поля' : 'полей'}
                </button>
              )}
            </span>
            <span className="bk-actions">
              <button type="button" disabled={busy} onClick={onClose}>
                Отмена
              </button>
              <button type="submit" className="primary" disabled={busy}>
                {mainLabel}
                {isLast && warnings.length > 0 && !busy && <small className="cx-warn-count"> · с предупреждениями: {warnings.length}</small>}
              </button>
            </span>
            {busy && callPlacement && (
              <p className="bk-submit-feedback muted" role="status">
                {certificateMode ? 'Оформляем сертификат…' : 'Создаём бронь в Битрикс24…'}
              </p>
            )}
            {error && (callPlacement || isLast) && (
              <p className="bk-submit-feedback notice error" role="alert">
                {error.text}
                {error.section && error.section !== shownActive && (
                  <>
                    {' '}
                    <button type="button" className="link" onClick={() => open(error.section!)}>
                      Открыть «{SECTION_TITLES[error.section]}»
                    </button>
                  </>
                )}
              </p>
            )}
          </footer>
        )}
        {askFields && needDecision && (
          <FieldsDecision
            fields={filled}
            onDone={(clear) => {
              for (const code of clear) fieldState.set(code, '');
              setDecided({ key: formKey, cleared: clear.length });
              const to = askFields;
              setAskFields(null);
              if (to === 'review') {
                setTouched(new Set(sections));
                setVisited((v) => new Set(v).add('review'));
                setOpened('review');
              }
            }}
          />
        )}
      </form>
    </div>
  );
}

/** Ошибка создания — в каком разделе её исправлять (409 пересечение/стоп — ресурс и время и т. д.). */
export function errorSection(text: string): SectionKey | null {
  const t = text.toLowerCase();
  if (/занят|пересека|стоп|закрыт|прошл/.test(t)) return 'slot';
  if (/тип брон|тип бронирования|товар/.test(t)) return 'goods';
  if (/пол[ея] «|заполните поле|поле сделки/.test(t)) return 'fields';
  if (/нет права|нет доступа/.test(t)) return 'when';
  return null;
}

/** Название новой сделки (решение владельца 2026-10-23): «Имя клиента 25.10.2026 Баня 1». */
export function newDealTitle(client: string | null | undefined, date: string, resources: string[]): string {
  const day = date ? `${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(0, 4)}` : '';
  return [client?.trim() || 'Новая сделка', day, resources.join(', ')].filter(Boolean).join(' ').slice(0, 255);
}

const toCard = (d: CrmDealHit): DealCard => ({
  id: d.id,
  title: d.title,
  categoryId: d.categoryId,
  closed: d.closed,
  client: d.contact?.name ?? null,
  opportunity: d.opportunity,
  lastActivityAt: d.lastActivityAt,
  tone: d.tone,
  modifiedBy: d.modifiedBy,
});

/** Цвет сделки: с сервера; без него — по брони сделки. */
const toneOf = (d: DealCard): DealBookingTone => d.tone ?? (d.booking ? 'booked' : 'empty');
/** Что значит цвет сделки — рядом с заголовком списка. */
const TONE_LEGEND: LegendItem[] = [
  { label: 'есть бронь', swatch: { borderColor: '#f04438', background: '#fef3f2' }, title: 'По сделке уже есть бронь' },
  { label: 'нет брони, заполнена', swatch: { borderColor: '#eaaa08', background: '#fefbe8' }, title: 'Брони нет, но в сделке остались заполнены поля брони' },
  { label: 'нет брони, пустая', swatch: { borderColor: '#47cd89', background: '#f6fef9' }, title: 'Пустая сделка — подходит для новой брони' },
];
const ToneLegend = () => <ColorLegend items={TONE_LEGEND} label="Цвета сделок" />;

/** Кто последним изменил сделку: аватарка и имя сотрудника. */
function DealModifier({ by }: { by?: CrmDealHit['modifiedBy'] }) {
  if (!by) return null;
  return (
    <span className="wz-deal-modifier" title="Последним изменял сделку">
      <Avatar src={by.photo} name={by.name} size={18} />
      <span>{by.name}</span>
    </span>
  );
}

const DEAL_TONE_TITLES: Record<DealBookingTone, string> = {
  booked: 'По сделке уже есть бронь',
  filled: 'Брони нет, но в сделке остались заполнены поля брони',
  empty: 'Пустая сделка — подходит для новой брони',
};

/**
 * В сделке уже заполнены поля формы — что с ними делать: оставить (по умолчанию) или очистить.
 * Сверху «Оставить все» и «Очистить все» (сразу дальше) и «Продолжить» — по переключателям полей ниже.
 */
function FieldsDecision({ fields, onDone }: { fields: DealFormField[]; onDone: (clear: string[]) => void }) {
  const [clear, setClear] = useState<Set<string>>(new Set());
  const toggle = (code: string, on: boolean) =>
    setClear((prev) => {
      const next = new Set(prev);
      if (on) next.add(code);
      else next.delete(code);
      return next;
    });
  return (
    <div className="wz-modal-backdrop" role="presentation">
      <div className="wz-modal" role="dialog" aria-modal="true" aria-label="В сделке уже заполнены поля">
        <h4>В сделке уже заполнены поля</h4>
        <p className="muted">Оставить значения или очистить перед новой бронью?</p>
        {/* Решение владельца 2026-10-26: «Оставить все» и «Очистить все» сразу продолжают, «Продолжить» — по выбору ниже. */}
        <div className="wz-modal-all">
          <button type="button" onClick={() => onDone([])} title="Оставить все значения и перейти дальше">
            Оставить все
          </button>
          <button type="button" onClick={() => onDone(fields.map((f) => f.code))} title="Очистить все эти поля сделки и перейти дальше">
            Очистить все
          </button>
          <button type="button" className="primary" onClick={() => onDone([...clear])} title="Оставить и очистить поля, как выбрано ниже">
            Продолжить
          </button>
        </div>
        <ul className="wz-filled">
          {fields.map((f) => (
            <li key={f.code}>
              <span className="wz-filled-name">
                <b>{f.label}</b>
                <span className="muted">{f.display || f.value}</span>
              </span>
              <span className="segmented wz-keep" role="group" aria-label={f.label}>
                <button type="button" className={!clear.has(f.code) ? 'active' : ''} aria-pressed={!clear.has(f.code)} onClick={() => toggle(f.code, false)}>
                  Оставить
                </button>
                <button type="button" className={clear.has(f.code) ? 'active' : ''} aria-pressed={clear.has(f.code)} onClick={() => toggle(f.code, true)}>
                  Очистить
                </button>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Даты с первой по последнюю включительно (не больше 14). */
function datesBetween(from: string, to: string): string[] {
  const out = [from];
  while (out.length < 14 && out[out.length - 1] < to) out.push(shiftDate(out[out.length - 1], 1));
  return out;
}

/** Несколько дней календаря группы — один набор: ресурсы первого дня, брони и тех. окна без повторов. */
function mergeDays(list: CalendarDay[]): CalendarDay {
  const bookings = new Map(list.flatMap((d) => d.bookings).map((b) => [b.id, b]));
  const tech = new Map(list.flatMap((d) => d.techWindows).map((t) => [`${t.resourceId}:${t.start}`, t]));
  const stops = new Map(list.flatMap((d) => d.stops ?? []).map((s) => [s.id, s]));
  return { ...list[0], bookings: [...bookings.values()], techWindows: [...tech.values()], stops: [...stops.values()] };
}
