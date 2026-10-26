import { freshPoll } from '../fresh-poll.js';
import { useEffect, useMemo, useState } from 'react';
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
import { ProductsEditor, productsTotal, type ProductRow } from './ProductsEditor.js';
import { isPastStart, SlotPicker, useNow } from './SlotPicker.js';
import { MinimizeButton } from '../Minimize.js';

export interface BookingFormContext {
  date: string;
  time?: string;
  groupId?: string | null;
  resourceId?: number | null;
  /** Сделка, из которой открыли (встройка) — шаг «Клиент и сделка» не нужен. */
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
type Step = 'deal' | 'group' | 'kind' | 'certificate' | 'slot' | 'details';
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
/** Сделок клиента на шаге сразу и сколько добавляет «Показать ещё» (по 2 в строке). */
const DEALS_STEP = 4;

/** Начало брони уже прошло. */
const PAST_START_ERROR = 'Начало брони уже прошло — выберите сегодня позже текущего времени или другой день';

const STEP_TITLES: Record<Step, string> = {
  deal: 'Клиент и сделка',
  group: 'Группа',
  kind: 'Тип сделки',
  certificate: 'Сертификат',
  slot: 'Дата и ресурс',
  details: 'Товары и поля',
};

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

/**
 * Какие шаги нужны (решение владельца 2026-10-22): из меню/маркетплейса — клиент или сделка →
 * группа → календарь группы (бронь кликом) → товары и поля; из сделки — без первого шага; клик в
 * календаре — без шагов группы и даты; одна доступная группа — без шага группы. У группы с типами
 * сделки (бани, 2026-10-23) после группы — «Тип сделки»; «Покупка сертификата» — без брони: шаг
 * «Сертификат» вместо даты и товаров.
 */
export function wizardSteps(
  ctx: Pick<BookingFormContext, 'dealId' | 'resourceId'>,
  groupsCount: number,
  opts: { kinds?: boolean; kind?: DealKind | null } = {},
): Step[] {
  const certificate = !!opts.kinds && opts.kind === 'certificate';
  return [
    ...(ctx.dealId ? [] : (['deal'] as const)),
    ...(ctx.resourceId || groupsCount <= 1 ? [] : (['group'] as const)),
    ...(opts.kinds ? (['kind'] as const) : []),
    ...(certificate ? (['certificate'] as const) : [...(ctx.resourceId ? [] : (['slot'] as const)), 'details' as const]),
  ];
}

/**
 * Мастер брони: клиент и сделка (поиск по телефону или 20 сделок с последней активностью) →
 * группа → календарь группы (дата, ресурсы, бронь кликом) → в сделке уже заполнены поля —
 * оставить или очистить → товары (скидки) и поля сделки группы → создать.
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
  const [groupId, setGroupId] = useState(
    () => allowed.find((g) => g.id === context.groupId || (context.resourceId && g.resourceIds.includes(context.resourceId)))?.id ?? allowed[0]?.id ?? '',
  );
  const group = allowed.find((g) => g.id === groupId);
  // Тип сделки (группы с `dealKinds`): от него — шаги, оплата и обязательные поля.
  const [kind, setKind] = useState<DealKind | null>('visit');
  const [step, setStep] = useState<Step>(() => wizardSteps(context, allowed.length)[0]);
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
  const steps = useMemo(() => wizardSteps(context, allowed.length, { kinds: kindsOn, kind }), [context, allowed.length, kindsOn, kind]);
  const stepIndex = Math.max(0, steps.indexOf(step));
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
  const [error, setError] = useState('');
  // Один ключ на открытие формы: повторная отправка (обрыв связи) не создаст вторую бронь.
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);

  // Шаг 1 без клиента: 20 сделок с последней активностью (чаты, звонки, дела).
  const needRecent = step === 'deal' && !client.contactId && !dealList.length;
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

  // Дни брони группы (с первого по последний, до 14): занятость ресурсов на всё время брони —
  // шаг «Дата и ресурс» и селектор ресурса в деталях.
  const bookingDates = datesBetween(period.startDate, period.endDate);
  const dayKey = `${groupId}|${bookingDates.join(',')}`;
  const [day, setDay] = useState<{ key: string; data: CalendarDay | null } | null>(null);
  useEffect(() => {
    if (!groupId) return;
    let active = true;
    const [gid, dates] = dayKey.split('|');
    const stop = freshPoll(() => Promise.all(dates.split(',').map((date) => apiGet<CalendarDay>(`/calendar?date=${date}&groupId=${encodeURIComponent(gid)}`))).then(
      (list) => active && setDay({ key: dayKey, data: mergeDays(list) }),
      () => active && setDay({ key: dayKey, data: null }),
    ));
    return () => { active = false; stop(); };
  }, [groupId, dayKey]);
  const dayData = day?.key === dayKey ? day.data : null;
  // Новые дни ещё грузятся — таймлайн показывает прежние под загрузчиком (проверки — только по свежим).
  const dayLoading = day?.key !== dayKey;
  const list = dayData?.resources ?? null;

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
  const [decided, setDecided] = useState<string>('');
  const askFields = step === 'details' && filled.length > 0 && decided !== formKey;

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
  // Товары сделки — заново при каждом входе на шаг «Товары и поля» (могли поменяться в портале или
  // прошлой бронью), пока сотрудник их не правил. Сбой — ошибка с повтором, а не «товаров нет»:
  // иначе добавленный товар заменил бы товары сделки.
  const [productsTry, setProductsTry] = useState(0);
  const onDetails = step === 'details';
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
  }, [existingDealId, onDetails, productsTry]);
  const nights =
    group?.bookingMode === 'interval' ? Math.max(1, Math.round((Date.parse(period.endDate) - Date.parse(period.startDate)) / 86_400_000) || 1) : 1;
  const defaultRows: ProductRow[] = cat
    ? resourceIds.flatMap((rid) =>
        (cat.defaults?.[String(rid)] ?? []).flatMap((dp) => {
          const p = cat.products?.find((x) => x.id === dp.productId);
          // В режиме «заезд/выезд» количество — по числу ночей (как в прототипе).
          return p ? [{ productId: p.id, name: p.name, price: p.price ?? 0, quantity: dp.quantity * nights, discountType: 'percent' as const, discount: 0 }] : [];
        }),
      )
    : [];
  const loadedProducts = products?.key === productsKey ? products : null;
  const productRows = deal.mode === 'new' ? (loadedProducts?.dirty ? loadedProducts.rows : defaultRows) : (loadedProducts?.rows ?? []);
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

  const chooseGroup = (id: string) => {
    setGroupId(id);
    const g = allowed.find((x) => x.id === id);
    if (g) setPeriod(defaultPeriod(g, period.startDate, period.startTime));
    setResourceIds((prev) => prev.filter((r) => g?.resourceIds.includes(r)));
    // Другая группа — другие права: недоступный выбор сбрасывается.
    if (deal.mode === 'new' && !g?.permissions.includes('deal.create')) setDeal({ mode: 'service' });
    if (!PAYMENT_MODES.filter((m) => canUsePaymentMode(g?.permissions ?? [], m)).includes(paymentMode)) setPaymentMode('prepayment');
    setBookingTypeId('');
  };

  // Группы, где можно создать именно такую бронь (новая сделка — нужно право на сделки) — в порядке
  // из настроек (⚙ → «Группы», стрелки); группа воронки выбранной сделки только выбирается и помечается.
  const anyNewDeal = allowed.some((g) => g.permissions.includes('deal.create'));
  const chosenDeal = deal.mode === 'existing' ? deals.find((d) => d.id === deal.dealId) : undefined;
  const dealCategory = chosenDeal?.categoryId ?? null;
  const groupChoices = allowed.filter((g) => deal.mode !== 'new' || g.permissions.includes('deal.create'));
  const dealLabel =
    deal.mode === 'none' ? null : deal.mode === 'service' ? 'служебная' : deal.mode === 'new' ? 'новая сделка' : chosenDeal ? `${chosenDeal.title} #${chosenDeal.id}` : `#${deal.dealId}`;

  /** Почему с шага `s` нельзя идти дальше; null — можно. */
  const blocker = (s: Step): string | null => {
    if (s === 'deal') {
      if (deal.mode === 'none') return 'Выберите сделку, найдите клиента или создайте новую сделку';
    }
    if (s === 'group' && !groupChoices.some((g) => g.id === groupId)) return 'Выберите группу';
    if (s === 'kind' && !kind) return 'Выберите тип сделки';
    if (s === 'slot' && !resourceIds.length) return 'Выберите время и ресурс в календаре';
    if (s === 'slot' && pastStart) return PAST_START_ERROR;
    if (s === 'slot') {
      const stop = (dayData?.stops ?? []).find((x) => resourceIds.includes(x.resourceId) && Date.parse(x.start) < endMs && Date.parse(x.end) > startMs);
      if (stop) return `${names.get(stop.resourceId) ?? 'Ресурс'} закрыт (стоп): ${stop.reason}`;
    }
    return null;
  };
  /**
   * Переход на любой шаг: назад — сразу; вперёд — если пройденные по пути шаги заполнены, иначе
   * остаёмся на первом незаполненном с подсказкой.
   */
  const goTo = (target: Step) => {
    setError('');
    const to = steps.indexOf(target);
    if (to <= stepIndex) return setStep(target);
    for (let i = stepIndex; i < to; i++) {
      const err = blocker(steps[i]);
      if (err) {
        setStep(steps[i]);
        return setError(err);
      }
      if (steps[i] === 'deal') {
        // Группа по воронке сделки — подсказка; выбор остаётся за сотрудником.
        const preferred = groupChoices.find((g) => dealCategory !== null && g.dealCategoryId === dealCategory) ?? groupChoices.find((g) => g.id === groupId) ?? groupChoices[0];
        if (preferred && preferred.id !== groupId) chooseGroup(preferred.id);
      }
    }
    setStep(target);
  };
  const goNext = () => {
    const nextStep = steps[stepIndex + 1];
    if (nextStep) goTo(nextStep);
    else setError(blocker(step) ?? '');
  };
  const goBack = () => {
    setError('');
    const prev = steps[stepIndex - 1];
    if (prev) setStep(prev);
  };

  // Оплата по типу сделки; без типа — как выбрал менеджер.
  const effectiveMode: PaymentMode =
    kindsOn && kind && kind !== 'certificate' ? (kind === 'by_certificate' ? (sendLink ? 'prepayment' : 'certificate') : DEAL_KIND_PAYMENT[kind]) : paymentMode;
  const typeRequired = !!group?.bookingTypeRequired || (kindsOn && (kind === 'visit' || kind === 'by_certificate') && (group?.bookingTypes ?? []).length > 0);

  const values = fieldState.values;
  const submit = async () => {
    if (busy) return;
    if (kindsOn && kind === 'certificate') return sellCertificate();
    const p = periodToUtc(period, timezone);
    if ('error' in p) return setError(p.error);
    if (!resourceIds.length) return setError('Выберите ресурс');
    if (pastStart) return setError(PAST_START_ERROR);
    if (deal.mode === 'none') return setError('Выберите сделку на первом шаге');
    if (kindsOn && !kind) return setError('Выберите тип сделки');
    if (deal.mode !== 'service' && !modes.includes(effectiveMode)) return setError(`«${PAYMENT_MODE_LABELS[effectiveMode]}» — нет права в этой группе`);
    if (kindsOn && typeRequired && !bookingTypeId) return setError('Выберите тип бронирования');
    if (deal.mode === 'new' && group?.bookingTypeRequired && !bookingTypeId && !productRows.length)
      return setError('Выберите тип брони или добавьте товары: у новой сделки ещё нет товаров');
    if (kindsOn && kind === 'by_certificate' && sendLink && !(Number(prepayAmount.replace(',', '.')) > 0))
      return setError('Заполните «Сумму предоплаты» — по ней будет ссылка на оплату');
    if (deal.mode !== 'service' && formKey && !currentForm) return setError('Поля сделки ещё загружаются');
    const missing = deal.mode === 'service' ? undefined : createFields.find((f) => f.required && !f.readOnly && !values[f.code]?.trim());
    if (missing) return setError(`Заполните поле «${missing.label}»`);
    const dealFields = Object.fromEntries(createFields.filter((f) => !f.readOnly).map((f) => [f.code, values[f.code] ?? '']));
    const commentText = (deal.mode !== 'service' && commentField ? (values[commentField.code] ?? '') : comment).trim();
    setBusy(true);
    setError('');
    try {
      const r = await apiPost<CreateBookingResultDto>('/bookings', {
        idempotencyKey,
        groupId,
        kind: deal.mode === 'service' ? 'service' : 'client',
        resourceIds,
        start: p.start,
        end: p.end,
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
        // Товары — если их меняли (или у новой сделки есть товары по умолчанию): строки сделки заменяются.
        ...(deal.mode !== 'service' && (loadedProducts?.dirty || (deal.mode === 'new' && productRows.length))
          ? {
              products: productRows
                .filter((r) => r.quantity > 0)
                .map((r) => ({ productId: r.productId, quantity: r.quantity, price: r.price, discountType: r.discountType, discount: r.discount })),
            }
          : {}),
      });
      const mode = deal.mode === 'service' ? null : effectiveMode;
      onDone({
        booking: r,
        dealId: r.dealId,
        payment: mode === 'prepayment' && r.dealId ? { amount: kind === 'by_certificate' ? Number(prepayAmount.replace(',', '.')) || null : null, fixedDeal: false } : null,
        note: `Бронь #${r.bookingId} создана${r.dealId ? ` в сделке #${r.dealId}` : ''}.${r.warnings.length ? ` ${r.warnings.join(' ')}` : ''}`,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось создать бронь');
    } finally {
      setBusy(false);
    }
  };

  /** «Покупка сертификата»: сделка + сертификат, затем окно оплаты на весь номинал. */
  const sellCertificate = async () => {
    if (busy) return;
    const nominal = Number(cert.nominal.replace(',', '.').replace(/\s/g, ''));
    if (deal.mode !== 'existing' && deal.mode !== 'new') return setError('Выберите сделку или новую сделку на первом шаге');
    if (!(nominal > 0)) return setError('Укажите сумму сертификата');
    if (!cert.holder.trim()) return setError('Укажите, на чьё имя сертификат');
    if (!cert.validUntil) return setError('Укажите срок действия');
    setBusy(true);
    setError('');
    try {
      const r = await apiPost<SellCertificateResultDto>('/certificates/sale', {
        idempotencyKey,
        groupId,
        dealId: deal.mode === 'existing' ? deal.dealId : null,
        newDeal: deal.mode === 'new' ? { title: newDealTitle(client.name, todayIn(timezone), ['сертификат']), contactId: client.contactId } : null,
        nominal,
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
      setError(e instanceof Error ? e.message : 'Не удалось оформить сертификат');
    } finally {
      setBusy(false);
    }
  };

  const pick = (d: DealChoice) => {
    setDeal(d);
    setError('');
  };
  // Сделки клиента: последняя открытая видна сразу, остальные — по «Показать ещё».
  const dealCards: DealCard[] = [...(context.dealId && !deals.some((d) => d.id === context.dealId) ? [{ id: context.dealId, title: 'Эта сделка' }] : []), ...deals];
  const selectedId = deal.mode === 'existing' ? deal.dealId : null;
  const visibleDeals = dealCards.filter((d, i) => i < dealsShown || d.id === selectedId);
  const hiddenCount = dealCards.length - visibleDeals.length;
  const names = new Map((list ?? []).map((r) => [r.id, r.name]));

  // Выбран клиент поиском — его сделки (последняя открытая — первой); нет открытых — новая сделка.
  const chooseContact = async (c: CrmContactHit) => {
    setClient({ contactId: c.id, name: c.name });
    setClientCard(c);
    setSearching(false);
    setDealsShown(DEALS_STEP);
    try {
      const r = await apiGet<CrmSearchDto>(`/crm/search?contactId=${c.id}`);
      setDealList(r.deals.map(toCard));
      const open = r.deals.find((d) => !d.closed);
      pick(open ? { mode: 'existing', dealId: open.id } : anyNewDeal ? { mode: 'new' } : { mode: 'service' });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить сделки клиента');
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

  // Занятость ресурса на выбранное время — для селектора ресурса.
  const startMs = Date.parse(zonedTimeToUtc(period.startDate, period.startTime || '00:00', timezone).toISOString());
  const endMs = Date.parse(zonedTimeToUtc(period.endDate, period.endTime || '00:00', timezone).toISOString());
  // Бронь в прошлом не нужна: предоплата и сверка ждут будущую (запас — 5 минут на заполнение формы).
  const now = useNow();
  const pastStart = isPastStart(startMs, now);
  const busyUntil = (rid: number): string | null => {
    const b = (dayData?.bookings ?? []).filter((x) => x.resourceIds.includes(rid) && Date.parse(x.start) < endMs && Date.parse(x.end) > startMs);
    return b.length ? fmtTime(b.reduce((m, x) => (Date.parse(x.end) > Date.parse(m) ? x.end : m), b[0].end), timezone) : null;
  };

  // Слот: пересекается с бронью — занято (Битрикс24 не даст), с тех. окном — можно, с предупреждением.

  // Сводка внизу: клиент · сделка · ресурс · дата/время · длительность · сумма.
  const utc = periodToUtc(period, timezone);
  const total = productsTotal(productRows);
  const summary = [
    client.name,
    deal.mode === 'existing' ? `сделка #${deal.dealId}` : deal.mode === 'new' ? 'новая сделка' : deal.mode === 'service' ? 'служебная' : null,
    step === 'details' || step === 'slot' ? resourceIds.map((id) => names.get(id)).filter(Boolean).join(', ') || null : null,
    (step === 'details' || step === 'slot') && resourceIds.length
      ? `${period.startDate.slice(8, 10)}.${period.startDate.slice(5, 7)} ${period.startTime}–${period.endDate !== period.startDate ? `${period.endDate.slice(8, 10)}.${period.endDate.slice(5, 7)} ` : ''}${period.endTime}`
      : null,
    (step === 'details' || step === 'slot') && resourceIds.length && !('error' in utc) ? durationText(Date.parse(utc.end) - Date.parse(utc.start)) : null,
    step === 'details' && total ? fmtMoney(total, 'RUB') : null,
  ].filter(Boolean);

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

  const dealStep = (
    <section className="bk-section">
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
            <button type="button" className="bk-more" aria-expanded={searching} onClick={() => setSearching(!searching)}>
              Изменить
            </button>
            {!context.contactId && (
              <button type="button" className="bk-more" onClick={resetClient}>
                Сбросить
              </button>
            )}
          </div>
          {searching && <ClientPicker onContact={(c) => void chooseContact(c)} onDeal={chooseDeal} autoFocus />}
          <h4 className="bk-title wz-deals-title">
            Сделки клиента <ToneLegend />
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
        <button type="button" role="radio" aria-checked={deal.mode === 'service'} className={`bk-service${deal.mode === 'service' ? ' selected' : ''}`} onClick={() => pick({ mode: 'service' })}>
          {deal.mode === 'service' ? '✓ Служебная бронь — без сделки (ремонт, уборка…)' : 'Служебная бронь без сделки'}
        </button>
      </div>
    </section>
  );

  const groupStep = (
    <section className="bk-section">
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
      {!groupChoices.length && <p className="notice error">Нет групп, где вам можно создать такую бронь.</p>}
    </section>
  );

  const kindStep = (
    <section className="bk-section">
      <div className="wz-groups wz-kinds" role="radiogroup" aria-label="Тип сделки">
        {DEAL_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={kind === k}
            className={`wz-group${kind === k ? ' selected' : ''}`}
            onClick={() => {
              setKind(k);
              setError('');
            }}
          >
            <b>{DEAL_KIND_LABELS[k]}</b>
            <span className="muted">{DEAL_KIND_HINTS[k]}</span>
          </button>
        ))}
      </div>
    </section>
  );

  const certificateStep = (
    <section className="bk-section">
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
        Сделка получит тип «Покупка сертификата» и сумму, сертификат появится в 🎟 «Сертификаты» (не оплачен). Дальше — ссылка на оплату всей
        суммы.
      </p>
    </section>
  );

  const slotStep = group ? (
    <SlotPicker compact={callPlacement} group={group} timezone={timezone} period={period} onPeriod={setPeriod} days={dayData ?? day?.data ?? null} loading={dayLoading} resourceIds={resourceIds} onResources={setResourceIds} />
  ) : null;

  const detailsStep = (
    <>
      <section className="bk-section">
        <h4 className="bk-title">
          Где и когда
          {steps.includes('slot') && (
            <button type="button" className="bk-more wz-change" onClick={() => goTo('slot')}>
              Изменить
            </button>
          )}
        </h4>
        {/* Только ресурс(ы) этой брони — выбор и смена ресурса на шаге «Дата и ресурс». */}
        <div className="wz-resources" role="list" aria-label="Ресурс брони">
          {(list ?? []).filter((r) => resourceIds.includes(r.id)).map((r) => {
            const until = busyUntil(r.id);
            const on = resourceIds.includes(r.id);
            return (
              <span key={r.id} role="listitem" className={`wz-resource${on ? ' selected' : ''}${until ? ' busy' : ''}`}>
                <b>{r.name}</b>
                <span className={`wz-res-state${until ? ' busy' : ''}`}>{until ? `занят до ${until}` : 'свободен'}</span>
              </span>
            );
          })}
          {!list && <p className="cp-hint">Загрузка ресурсов…</p>}
        </div>
        <div className="df-grid wz-time">
          <div className="df-row pair">
            <label className="df-field">
              <span className="df-label">Начало</span>
              <span className="bk-dt">
                <input type="date" aria-label="Дата начала" required value={period.startDate} onChange={(e) => setPeriod({ ...period, startDate: e.target.value })} />
                <input type="time" aria-label="Время начала" required value={period.startTime} onChange={(e) => setPeriod({ ...period, startTime: e.target.value })} />
              </span>
            </label>
            <label className="df-field">
              <span className="df-label">Конец</span>
              <span className="bk-dt">
                <input type="date" aria-label="Дата конца" required value={period.endDate} onChange={(e) => setPeriod({ ...period, endDate: e.target.value })} />
                <input type="time" aria-label="Время конца" required value={period.endTime} onChange={(e) => setPeriod({ ...period, endTime: e.target.value })} />
              </span>
            </label>
          </div>
        </div>
      </section>

      {deal.mode !== 'service' && (
        <section className="bk-section">
          <h4 className="bk-title">
            Товары
            {deal.mode === 'existing' && <span className="bk-title-hint"> · изменения заменят товары сделки</span>}
          </h4>
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
        </section>
      )}

      {deal.mode !== 'service' && (
        <section className="bk-section">
          <h4 className="bk-title">Бронь и оплата</h4>
          <div className="df-grid">
            <div className="df-row pair">
              {group && (group.bookingTypes ?? []).length > 0 && !kindsOn && (
                <label className="df-field">
                  <span className="df-label">
                    Тип брони{group.bookingTypeRequired && <i className="df-req">*</i>}
                  </span>
                  <select value={bookingTypeId} onChange={(e) => setBookingTypeId(e.target.value)}>
                    {!(group.bookingTypeRequired && deal.mode === 'new' && !productRows.length) && <option value="">По товарам сделки</option>}
                    {group.bookingTypeRequired && deal.mode === 'new' && !productRows.length && !bookingTypeId && <option value="">Выберите…</option>}
                    {(group.bookingTypes ?? []).map((t) => (
                      <option key={t.id} value={t.id} disabled={t.unavailable}>
                        {t.title}
                        {t.unavailable ? ' — сейчас недоступен' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {kindsOn && kind ? (
                <div className="df-field">
                  <span className="df-label">Оплата</span>
                  <span className="wz-pay-mode">{PAYMENT_MODE_LABELS[effectiveMode]}</span>
                </div>
              ) : (
                <label className="df-field">
                  <span className="df-label">Оплата</span>
                  <select value={paymentMode} onChange={(e) => setPaymentMode(e.target.value as PaymentMode)}>
                    {modes.map((m) => (
                      <option key={m} value={m}>
                        {PAYMENT_MODE_LABELS[m]}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {/* Тип бронирования по типу сделки — карточками; недоступный (Теремок) виден, но не выбирается. */}
            {kindsOn && group && (group.bookingTypes ?? []).length > 0 && (
              <div className="df-field">
                <span className="df-label">
                  Тип бронирования{typeRequired && <i className="df-req">*</i>}
                </span>
                <span className="wz-types" role="radiogroup" aria-label="Тип бронирования">
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
            {!guestsField && (
              <div className="df-row pair">
                <label className="df-field">
                  <span className="df-label">Гостей</span>
                  <input type="number" min={0} max={1000} value={guests} onChange={(e) => setGuests(e.target.value)} />
                </label>
              </div>
            )}
          </div>
        </section>
      )}

      {deal.mode !== 'service' && createFields.length > 0 && (
        <section className="bk-section">
          <h4 className="bk-title">Поля сделки</h4>
          <DealFieldsEditor fields={createFields} values={values} auto={fieldState.auto} onChange={fieldState.set} onResetFormula={fieldState.resetFormula} />
        </section>
      )}
      {deal.mode !== 'service' && formKey && !currentForm && <p className="bk-loading">Загрузка полей сделки…</p>}
      {currentForm?.error && <p className="notice error">{currentForm.error}</p>}
      {(deal.mode === 'service' || !commentField) && (
        <section className="bk-section">
          <label className="df-field">
            <span className="df-label">Комментарий</span>
            <textarea rows={2} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />
          </label>
        </section>
      )}
    </>
  );

  return (
    <div className={`sheet-backdrop${callPlacement ? ' call-booking-backdrop' : ''}`} onClick={() => !busy && onClose()}>
      <form
        className="sheet bk wz"
        role="dialog"
        aria-modal="true"
        aria-label="Новая бронь"
        onClick={(e) => e.stopPropagation()}
        onInvalidCapture={(e) => {
          const input = e.target;
          if (!(input instanceof HTMLInputElement || input instanceof HTMLSelectElement || input instanceof HTMLTextAreaElement)) return;
          // Браузер не вызовет onSubmit для невалидного поля; показываем причину возле кнопки.
          e.preventDefault();
          if (e.currentTarget.querySelector('input:invalid, select:invalid, textarea:invalid') !== input) return;
          const label = input.getAttribute('aria-label') || input.closest('label')?.querySelector('.df-label')?.textContent?.replace('*', '').trim() || input.closest('label')?.firstChild?.textContent?.trim() || 'Поле формы';
          setError(`Проверьте поле «${label}»: ${input.validationMessage}`);
          const body = input.closest('.bk-body');
          if (body) body.scrollTo({ top: body.scrollTop + input.getBoundingClientRect().top - body.getBoundingClientRect().top - 12 });
          input.focus({ preventScroll: true });
        }}
        onSubmit={(e) => {
          e.preventDefault();
          if (step === steps[steps.length - 1]) void submit();
          else goNext();
        }}
      >
        <header className="bk-head">
          <div>
            <h3>Новая бронь</h3>
            <span className="bk-sub">
              {[group?.name, kindsOn && kind ? DEAL_KIND_LABELS[kind] : null, client.name, deal.mode !== 'new' || step !== 'deal' ? dealLabel : null].filter(Boolean).join(' · ')}
            </span>
          </div>
          <MinimizeButton label="Новая бронь" />
          <button type="button" className="bk-close" aria-label="Закрыть" disabled={busy} onClick={onClose}>
            ×
          </button>
        </header>
        {steps.length > 1 && (
          <ol className="bk-steps wz-steps">
            {steps.map((s, i) => (
              <li key={s} className={s === step ? 'active' : stepIndex > i ? 'done' : 'ahead'}>
                {s === step ? (
                  STEP_TITLES[s]
                ) : (
                  // Пройденные и следующие шаги — кнопками: посмотреть или поменять заполненное.
                  <button type="button" className="wz-step-back" disabled={busy} onClick={() => goTo(s)}>
                    {STEP_TITLES[s]}
                  </button>
                )}
              </li>
            ))}
          </ol>
        )}
        <div className="bk-body" tabIndex={callPlacement ? 0 : undefined} aria-label={callPlacement ? 'Содержимое шага бронирования' : undefined}>
          {!allowed.length ? (
            <p className="notice error">Нет права создавать брони ни в одной группе.</p>
          ) : (
            <>
              {step === 'deal' && dealStep}
              {step === 'group' && groupStep}
              {step === 'kind' && kindStep}
              {step === 'certificate' && certificateStep}
              {step === 'slot' && slotStep}
              {step === 'details' && detailsStep}
              {error && !callPlacement && (
                <p className="notice error" role="alert">
                  {error}
                </p>
              )}
            </>
          )}
        </div>
        {allowed.length > 0 && (
          <footer className="bk-foot">
            <span className="bk-summary">{summary.join(' · ')}</span>
            <span className="bk-actions">
              {stepIndex > 0 && (
                <button type="button" disabled={busy} onClick={goBack}>
                  Назад
                </button>
              )}
              <button type="button" disabled={busy} onClick={onClose}>
                Отмена
              </button>
              {(step !== 'slot' || callPlacement) && (
                <button type="submit" className="primary" disabled={busy || (step === 'slot' && resourceIds.length === 0)} title={step === 'slot' && resourceIds.length === 0 ? 'Выберите ресурс и время на таймлайне' : undefined}>
                  {step !== steps[steps.length - 1] ? 'Далее' : busy ? 'Создаю…' : step === 'certificate' ? 'Оформить сертификат' : callPlacement && effectiveMode === 'prepayment' && deal.mode !== 'service' ? 'Далее: предоплата' : 'Создать бронь'}
                </button>
              )}
              {step === 'slot' && resourceIds.length > 0 && !callPlacement && (
                <button type="submit" className="primary">
                  Далее
                </button>
              )}
            </span>
            {callPlacement && busy && <p className="bk-submit-feedback muted" role="status">{kind === 'certificate' ? 'Оформляем сертификат…' : 'Создаём бронь в Битрикс24…'}</p>}
            {callPlacement && error && <p className="bk-submit-feedback notice error" role="alert">{error}</p>}
          </footer>
        )}
        {askFields && (
          <FieldsDecision
            fields={filled}
            onDone={(clear) => {
              for (const code of clear) fieldState.set(code, '');
              setDecided(formKey);
            }}
          />
        )}
      </form>
    </div>
  );
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
