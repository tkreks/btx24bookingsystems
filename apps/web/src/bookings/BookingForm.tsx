import { useEffect, useMemo, useState } from 'react';
import {
  canUsePaymentMode,
  PAYMENT_MODE_LABELS,
  PAYMENT_MODES,
  type CalendarDay,
  type CreateBookingResultDto,
  type DealFormDto,
  type MyGroupDto,
  type PaymentMode,
} from '@btx24/shared';
import { apiGet, apiPost } from '../api.js';
import { defaultPeriod, periodToUtc, type PeriodFields } from './booking-form.js';
import { DealFieldsEditor, initialValues } from './DealFieldsEditor.js';

export interface BookingFormContext {
  date: string;
  time?: string;
  groupId?: string | null;
  resourceId?: number | null;
  /** Сделка, из которой открыли (встройка) — предлагается первой. */
  dealId?: number | null;
  contactId?: number | null;
  clientName?: string | null;
  /** Открытые сделки клиента (из чата). */
  openDeals?: { id: number; title: string; categoryId?: number | null }[];
}

type DealChoice = { mode: 'existing'; dealId: number } | { mode: 'new'; title: string } | { mode: 'service' };

/**
 * Форма брони (календарь, чат, сделка): группа и ресурсы, время по режиму группы, сделка
 * (существующая / новая в воронке группы / служебная без сделки), гости, комментарий, оплата.
 * Товары и цены менеджер ведёт в сделке; тип брони приложение определит по ним.
 */
export function BookingForm({
  groups,
  timezone,
  context,
  wizard = false,
  onDone,
  onClose,
}: {
  groups: MyGroupDto[];
  timezone: string;
  context: BookingFormContext;
  /** Мастер (из чата): 1) по какой сделке, 2) какая группа, 3) время, ресурсы, оплата. */
  wizard?: boolean;
  /** paymentMode — чтобы после брони с предоплатой сразу предложить счёт. */
  onDone: (r: CreateBookingResultDto, paymentMode: PaymentMode | null) => void;
  onClose: () => void;
}) {
  const allowed = groups.filter((g) => g.permissions.includes('booking.create'));
  const [groupId, setGroupId] = useState(
    () => allowed.find((g) => g.id === context.groupId || (context.resourceId && g.resourceIds.includes(context.resourceId)))?.id ?? allowed[0]?.id ?? '',
  );
  const group = allowed.find((g) => g.id === groupId);
  const canNewDeal = !!group?.permissions.includes('deal.create');
  const modes = useMemo(() => PAYMENT_MODES.filter((m) => canUsePaymentMode(group?.permissions ?? [], m)), [group]);
  const [period, setPeriod] = useState<PeriodFields>(() =>
    group ? defaultPeriod(group, context.date, context.time) : { startDate: context.date, startTime: '14:00', endDate: context.date, endTime: '18:00' },
  );
  const [resources, setResources] = useState<{ groupId: string; list: { id: number; name: string }[] } | null>(null);
  const [resourceIds, setResourceIds] = useState<number[]>(context.resourceId ? [context.resourceId] : []);
  // Сделки клиента: сделка, из которой открыли, — первой, дальше самые новые (больший ID).
  const deals = [...(context.openDeals ?? [])].sort((a, b) => Number(b.id === context.dealId) - Number(a.id === context.dealId) || b.id - a.id);
  const [deal, setDeal] = useState<DealChoice>(() =>
    context.dealId
      ? { mode: 'existing', dealId: context.dealId }
      : deals[0]
        ? { mode: 'existing', dealId: deals[0].id }
        : canNewDeal
          ? { mode: 'new', title: '' }
          : { mode: 'service' },
  );
  const [guests, setGuests] = useState('');
  const [comment, setComment] = useState('');
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('prepayment');
  // '' — определить по товарам сделки (как БП 270).
  const [bookingTypeId, setBookingTypeId] = useState('');
  const [step, setStep] = useState<'deal' | 'group' | 'details'>(wizard ? 'deal' : 'details');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Один ключ на открытие формы: повторная отправка (обрыв связи) не создаст вторую бронь.
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);

  useEffect(() => {
    if (!groupId) return;
    let active = true;
    apiGet<CalendarDay>(`/calendar?date=${context.date}&groupId=${encodeURIComponent(groupId)}`).then(
      (d) => active && setResources({ groupId, list: d.resources }),
      () => active && setResources({ groupId, list: [] }),
    );
    return () => {
      active = false;
    };
    // Список ресурсов зависит от группы, не от даты (дата — только для запроса).
  }, [groupId, context.date]);

  const list = resources?.groupId === groupId ? resources.list : null;

  // Поля сделки группы (флаг «С»); у существующей сделки — с её текущими значениями.
  const formKey = deal.mode === 'service' || !groupId ? '' : `${groupId}:${deal.mode === 'existing' ? deal.dealId : ''}`;
  const [dealForm, setDealForm] = useState<{ key: string; form: DealFormDto | null; error: string } | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!formKey) return;
    let active = true;
    const [gid, did] = formKey.split(':');
    apiGet<DealFormDto>(`/deal-form?groupId=${encodeURIComponent(gid)}${did ? `&dealId=${did}` : ''}`).then(
      (f) => {
        if (!active) return;
        setDealForm({ key: formKey, form: f, error: '' });
        setValues(initialValues(f.fields));
      },
      (e) => active && setDealForm({ key: formKey, form: null, error: e instanceof Error ? e.message : 'Не удалось загрузить поля сделки' }),
    );
    return () => {
      active = false;
    };
  }, [formKey]);
  const currentForm = formKey && dealForm?.key === formKey ? dealForm : null;
  // Тип брони — отдельным выбором выше (с автоопределением по товарам).
  const createFields = (currentForm?.form?.fields ?? []).filter((f) => f.showCreate && f.role !== 'bookingType');
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

  // Мастер: группы, где можно создать именно такую бронь (новая сделка — нужно право на сделки);
  // для существующей сделки сначала — группы её воронки.
  const anyNewDeal = allowed.some((g) => g.permissions.includes('deal.create'));
  const chosenDeal = deal.mode === 'existing' ? deals.find((d) => d.id === deal.dealId) : undefined;
  const dealCategory = chosenDeal?.categoryId ?? null;
  const groupChoices = allowed
    .filter((g) => deal.mode !== 'new' || g.permissions.includes('deal.create'))
    .sort((a, b) => Number(b.dealCategoryId === dealCategory) - Number(a.dealCategoryId === dealCategory));
  const dealLabel =
    deal.mode === 'service' ? 'служебная (без сделки)' : deal.mode === 'new' ? `новая «${deal.title || '…'}»` : chosenDeal ? `${chosenDeal.title} #${chosenDeal.id}` : `#${deal.dealId}`;
  const next = () => {
    if (deal.mode === 'new' && !deal.title.trim()) return setError('Название новой сделки');
    setError('');
    // Группа по воронке сделки — подсказка; выбор остаётся за сотрудником.
    const preferred =
      groupChoices.find((g) => dealCategory !== null && g.dealCategoryId === dealCategory) ?? groupChoices.find((g) => g.id === groupId) ?? groupChoices[0];
    if (preferred && preferred.id !== groupId) chooseGroup(preferred.id);
    setStep('group');
  };

  const submit = async () => {
    const p = periodToUtc(period, timezone);
    if ('error' in p) return setError(p.error);
    if (!resourceIds.length) return setError('Выберите ресурс');
    if (deal.mode === 'new' && !deal.title.trim()) return setError('Название новой сделки');
    if (deal.mode === 'new' && group?.bookingTypeRequired && !bookingTypeId) return setError('Выберите тип брони: у новой сделки ещё нет товаров');
    if (deal.mode !== 'service' && formKey && !currentForm) return setError('Поля сделки ещё загружаются');
    const missing = deal.mode === 'service' ? undefined : createFields.find((f) => f.required && !f.readOnly && !values[f.code]?.trim());
    if (missing) return setError(`Заполните поле «${missing.label}»`);
    const dealFields = Object.fromEntries(createFields.filter((f) => !f.readOnly).map((f) => [f.code, values[f.code] ?? '']));
    const commentText = (deal.mode !== 'service' && commentField ? values[commentField.code] ?? '' : comment).trim();
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
        newDeal: deal.mode === 'new' ? { title: deal.title.trim(), contactId: context.contactId ?? null } : null,
        contactId: context.contactId ?? null,
        guests: !guestsField && guests ? Number(guests) : null,
        comment: commentText || undefined,
        paymentMode,
        bookingTypeId: deal.mode === 'service' ? null : bookingTypeId || null,
        ...(deal.mode === 'service' ? {} : { dealFields }),
      });
      onDone(r, deal.mode === 'service' ? null : paymentMode);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось создать бронь');
    } finally {
      setBusy(false);
    }
  };

  const [moreDeals, setMoreDeals] = useState(false);
  const pick = (d: DealChoice) => {
    setDeal(d);
    setError('');
  };
  // Карточки сделок: последняя (или выбранная) видна сразу, остальные — по «Показать ещё».
  const dealCards = [
    ...(context.dealId && !deals.some((d) => d.id === context.dealId) ? [{ id: context.dealId, title: 'Эта сделка' }] : []),
    ...deals,
  ];
  const selectedId = deal.mode === 'existing' ? deal.dealId : null;
  const visibleDeals = moreDeals ? dealCards : dealCards.filter((d, i) => i === 0 || d.id === selectedId);
  const hiddenCount = dealCards.length - visibleDeals.length;

  const dealBlock = (
    <section className="bf-section">
      <h4>{wizard ? 'По какой сделке бронь?' : 'Сделка'}</h4>
      <div className="bf-choices" role="radiogroup" aria-label="Сделка">
        {visibleDeals.map((d) => (
          <button
            key={d.id}
            type="button"
            role="radio"
            aria-checked={selectedId === d.id}
            className={`bf-choice${selectedId === d.id ? ' selected' : ''}`}
            onClick={() => pick({ mode: 'existing', dealId: d.id })}
          >
            <b>{d.title}</b>
            <span className="muted">#{d.id}{d.id === context.dealId ? ' · открыта сейчас' : d.id === dealCards[0]?.id ? ' · последняя' : ''}</span>
          </button>
        ))}
        {hiddenCount > 0 && (
          <button type="button" className="link bf-more" onClick={() => setMoreDeals(true)}>
            Показать ещё ({hiddenCount})
          </button>
        )}
        {(wizard ? anyNewDeal : canNewDeal) && (
          <div className={`bf-choice bf-new${deal.mode === 'new' ? ' selected' : ''}`}>
            {deal.mode === 'new' ? (
              <input
                aria-label="Название новой сделки"
                placeholder="Название новой сделки"
                autoFocus
                value={deal.title}
                maxLength={255}
                onChange={(e) => setDeal({ mode: 'new', title: e.target.value })}
              />
            ) : (
              <button type="button" className="link" onClick={() => pick({ mode: 'new', title: context.clientName ?? '' })}>
                ＋ Создать новую сделку
              </button>
            )}
          </div>
        )}
        <button
          type="button"
          className={`link bf-service${deal.mode === 'service' ? ' selected' : ''}`}
          onClick={() => pick({ mode: 'service' })}
        >
          {deal.mode === 'service' ? '✓ Служебная бронь — без сделки (ремонт, уборка…)' : 'Служебная бронь без сделки'}
        </button>
      </div>
    </section>
  );

  // Ресурсы: основной — выпадающим списком; дополнительные (редко) — «＋ ещё ресурс».
  const setResourceAt = (i: number, id: number) => setResourceIds((prev) => prev.map((r, k) => (k === i ? id : r)).filter((r, k, a) => a.indexOf(r) === k));
  const resourceRows = resourceIds.length ? resourceIds : [0];
  const freeResources = (list ?? []).filter((r) => !resourceIds.includes(r.id));

  return (
    <div className="sheet-backdrop" onClick={() => !busy && onClose()}>
      <form
        className="sheet booking-form"
        role="dialog"
        aria-modal="true"
        aria-label="Новая бронь"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (step === 'deal') return next();
          if (step === 'group') return setStep('details');
          void submit();
        }}
      >
        <header>
          <h3>Новая бронь{context.clientName ? ` — ${context.clientName}` : ''}</h3>
          <button type="button" aria-label="Закрыть" disabled={busy} onClick={onClose}>
            ×
          </button>
        </header>
        {!allowed.length ? (
          <p className="notice error">Нет права создавать брони ни в одной группе.</p>
        ) : (
          <>
            {step === 'deal' && dealBlock}
            {step === 'group' && (
              <section className="bf-section">
                <h4>Группа для брони</h4>
                <div className="bf-choices" role="radiogroup" aria-label="Группа">
                  {groupChoices.map((g) => (
                    <button
                      key={g.id}
                      type="button"
                      role="radio"
                      aria-checked={g.id === groupId}
                      className={`bf-choice${g.id === groupId ? ' selected' : ''}`}
                      onClick={() => chooseGroup(g.id)}
                    >
                      <b>{g.name}</b>
                      {dealCategory !== null && g.dealCategoryId === dealCategory && <span className="muted">воронка сделки</span>}
                    </button>
                  ))}
                </div>
                {!groupChoices.length && <p className="notice error">Нет групп, где вам можно создать такую бронь.</p>}
              </section>
            )}
            {step === 'details' && wizard && (
              <p className="wizard-summary">
                <span>
                  Сделка: <b>{dealLabel}</b>{' '}
                  <button type="button" className="link" onClick={() => setStep('deal')}>
                    изменить
                  </button>
                </span>
                <span>
                  Группа: <b>{group?.name}</b>{' '}
                  <button type="button" className="link" onClick={() => setStep('group')}>
                    изменить
                  </button>
                </span>
              </p>
            )}
            {step === 'details' && (
              <>
                <section className="bf-section">
                  <h4>Когда и где</h4>
                  <div className="bf-grid">
                    {!wizard && allowed.length > 1 && (
                      <label>
                        Группа
                        <select value={groupId} onChange={(e) => chooseGroup(e.target.value)}>
                          {allowed.map((g) => (
                            <option key={g.id} value={g.id}>
                              {g.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <div className="bf-resources">
                      <span className="bf-label">{resourceRows.length > 1 ? 'Ресурсы' : 'Ресурс'}</span>
                      <div className="bf-resource-row">
                        {resourceRows.map((rid, i) => (
                          <span key={i} className="bf-row">
                            <select
                              aria-label={i === 0 ? 'Ресурс' : `Ресурс ${i + 1}`}
                              value={rid || ''}
                              disabled={!list}
                              onChange={(e) => (resourceIds.length ? setResourceAt(i, Number(e.target.value)) : setResourceIds([Number(e.target.value)]))}
                            >
                              {!rid && <option value="">{list ? 'Выберите…' : 'Загрузка…'}</option>}
                              {(list ?? [])
                                .filter((r) => r.id === rid || !resourceIds.includes(r.id))
                                .map((r) => (
                                  <option key={r.id} value={r.id}>
                                    {r.name}
                                  </option>
                                ))}
                            </select>
                            {i > 0 && (
                              <button type="button" className="bf-icon" aria-label="Убрать ресурс" onClick={() => setResourceIds(resourceIds.filter((_, k) => k !== i))}>
                                ×
                              </button>
                            )}
                          </span>
                        ))}
                        {resourceIds.length > 0 && freeResources.length > 0 && (
                          <button type="button" className="link bf-add" onClick={() => setResourceIds([...resourceIds, freeResources[0].id])}>
                            ＋ ещё ресурс
                          </button>
                        )}
                      </div>
                    </div>
                    <label>
                      Начало
                      <span className="dt-pair">
                        <input type="date" required value={period.startDate} onChange={(e) => setPeriod({ ...period, startDate: e.target.value })} />
                        <input type="time" required value={period.startTime} onChange={(e) => setPeriod({ ...period, startTime: e.target.value })} />
                      </span>
                    </label>
                    <label>
                      Конец
                      <span className="dt-pair">
                        <input type="date" required value={period.endDate} onChange={(e) => setPeriod({ ...period, endDate: e.target.value })} />
                        <input type="time" required value={period.endTime} onChange={(e) => setPeriod({ ...period, endTime: e.target.value })} />
                      </span>
                    </label>
                  </div>
                </section>

                {!wizard && dealBlock}

                {deal.mode !== 'service' && (
                  <section className="bf-section">
                    <h4>Бронь и оплата</h4>
                    <div className="bf-grid">
                      {group && (group.bookingTypes ?? []).length > 0 && (
                        <label>
                          Тип брони{group.bookingTypeRequired ? ' *' : ''}
                          <select value={bookingTypeId} onChange={(e) => setBookingTypeId(e.target.value)}>
                            {!(group.bookingTypeRequired && deal.mode === 'new') && <option value="">По товарам сделки</option>}
                            {group.bookingTypeRequired && deal.mode === 'new' && !bookingTypeId && <option value="">Выберите…</option>}
                            {(group.bookingTypes ?? []).map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.title}
                              </option>
                            ))}
                          </select>
                          {group.bookingTypeRequired && !bookingTypeId && deal.mode === 'existing' && (
                            <small className="muted">Не определится по товарам — бронь не создастся.</small>
                          )}
                        </label>
                      )}
                      <label>
                        Оплата
                        <select value={paymentMode} onChange={(e) => setPaymentMode(e.target.value as PaymentMode)}>
                          {modes.map((m) => (
                            <option key={m} value={m}>
                              {PAYMENT_MODE_LABELS[m]}
                            </option>
                          ))}
                        </select>
                      </label>
                      {!guestsField && (
                        <label>
                          Гостей
                          <input type="number" min={0} max={1000} value={guests} onChange={(e) => setGuests(e.target.value)} />
                        </label>
                      )}
                    </div>
                  </section>
                )}

                {deal.mode !== 'service' && createFields.length > 0 && (
                  <section className="bf-section">
                    <h4>Поля сделки</h4>
                    <DealFieldsEditor fields={createFields} values={values} onChange={(code, v) => setValues((prev) => ({ ...prev, [code]: v }))} />
                  </section>
                )}
                {deal.mode !== 'service' && formKey && !currentForm && <p className="muted">Загрузка полей сделки…</p>}
                {currentForm?.error && <p className="notice error">{currentForm.error}</p>}
                {(deal.mode === 'service' || !commentField) && (
                  <label className="bf-comment">
                    Комментарий
                    <textarea rows={2} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />
                  </label>
                )}
              </>
            )}
            {error && (
              <p className="notice error" role="alert">
                {error}
              </p>
            )}
            <div className="form-actions bf-footer">
              {step !== 'deal' && wizard && (
                <button type="button" disabled={busy} onClick={() => setStep(step === 'details' ? 'group' : 'deal')}>
                  Назад
                </button>
              )}
              <button type="submit" className="primary" disabled={busy || (step === 'group' && !groupChoices.some((g) => g.id === groupId))}>
                {step !== 'details' ? 'Далее' : busy ? 'Создаю…' : 'Создать бронь'}
              </button>
              <button type="button" disabled={busy} onClick={onClose}>
                Отмена
              </button>
              {step === 'details' && <span className="muted bf-hint">Товары и цены — в сделке</span>}
            </div>
          </>
        )}
      </form>
    </div>
  );
}
