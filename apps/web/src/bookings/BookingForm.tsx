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
import { DealFieldsEditor, useDealFieldValues } from './DealFieldsEditor.js';

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

/** «4 ч», «1 сут 2 ч», «45 мин» — длительность брони для сводки. */
export function durationText(ms: number): string {
  const min = Math.round(ms / 60_000);
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  return [d ? `${d} сут` : '', h ? `${h} ч` : '', m ? `${m} мин` : ''].filter(Boolean).join(' ') || '0 мин';
}

/**
 * Форма брони (календарь, чат, сделка): когда и где → сделка (последняя клиента / ещё / новая /
 * служебная) → тип и оплата → поля сделки группы (порядок, «2 в линии», значения по умолчанию,
 * формулы — из настроек группы). Товары и цены менеджер ведёт в сделке.
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
  const [moreDeals, setMoreDeals] = useState(false);
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
  // Тип брони — отдельным выбором (с автоопределением по товарам).
  const createFields = useMemo(() => (currentForm?.form?.fields ?? []).filter((f) => f.showCreate && f.role !== 'bookingType'), [currentForm]);
  const fieldState = useDealFieldValues(createFields, 'create', currentForm ? formKey : '');
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

  const values = fieldState.values;
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

  const pick = (d: DealChoice) => {
    setDeal(d);
    setError('');
  };
  // Карточки сделок: последняя (или выбранная) видна сразу, остальные — по «Показать ещё».
  const dealCards = [...(context.dealId && !deals.some((d) => d.id === context.dealId) ? [{ id: context.dealId, title: 'Эта сделка' }] : []), ...deals];
  const selectedId = deal.mode === 'existing' ? deal.dealId : null;
  const visibleDeals = moreDeals ? dealCards : dealCards.filter((d, i) => i === 0 || d.id === selectedId);
  const hiddenCount = dealCards.length - visibleDeals.length;

  // Ресурсы: основной — выпадающим списком; дополнительные (редко) — «＋ ещё ресурс».
  const setResourceAt = (i: number, id: number) => setResourceIds((prev) => prev.map((r, k) => (k === i ? id : r)).filter((r, k, a) => a.indexOf(r) === k));
  const resourceRows = resourceIds.length ? resourceIds : [0];
  const freeResources = (list ?? []).filter((r) => !resourceIds.includes(r.id));
  const names = new Map((list ?? []).map((r) => [r.id, r.name]));

  // Сводка внизу: что и когда бронируем.
  const utc = periodToUtc(period, timezone);
  const summary = [
    resourceIds.map((id) => names.get(id)).filter(Boolean).join(', ') || null,
    `${period.startDate.slice(8, 10)}.${period.startDate.slice(5, 7)} ${period.startTime} — ${period.endDate !== period.startDate ? `${period.endDate.slice(8, 10)}.${period.endDate.slice(5, 7)} ` : ''}${period.endTime}`,
    'error' in utc ? null : durationText(Date.parse(utc.end) - Date.parse(utc.start)),
  ].filter(Boolean);

  const dealBlock = (
    <section className="bk-section">
      <h4 className="bk-title">{wizard ? 'По какой сделке бронь?' : 'Сделка'}</h4>
      <div className="bk-choices" role="radiogroup" aria-label="Сделка">
        {visibleDeals.map((d) => (
          <button
            key={d.id}
            type="button"
            role="radio"
            aria-checked={selectedId === d.id}
            className={`bk-choice${selectedId === d.id ? ' selected' : ''}`}
            onClick={() => pick({ mode: 'existing', dealId: d.id })}
          >
            <span className="bk-dot" aria-hidden="true" />
            <b>{d.title}</b>
            <span className="bk-meta">
              #{d.id}
              {d.id === context.dealId ? ' · открыта сейчас' : d.id === dealCards[0]?.id ? ' · последняя' : ''}
            </span>
          </button>
        ))}
        {hiddenCount > 0 && (
          <button type="button" className="bk-more" onClick={() => setMoreDeals(true)}>
            Показать ещё ({hiddenCount})
          </button>
        )}
        {(wizard ? anyNewDeal : canNewDeal) &&
          (deal.mode === 'new' ? (
            <div className="bk-choice selected bk-new">
              <span className="bk-dot" aria-hidden="true" />
              <input
                aria-label="Название новой сделки"
                placeholder="Название новой сделки"
                autoFocus
                value={deal.title}
                maxLength={255}
                onChange={(e) => setDeal({ mode: 'new', title: e.target.value })}
              />
            </div>
          ) : (
            <button type="button" className="bk-choice bk-add-deal" onClick={() => pick({ mode: 'new', title: context.clientName ?? '' })}>
              ＋ Создать новую сделку
            </button>
          ))}
        <button type="button" role="radio" aria-checked={deal.mode === 'service'} className={`bk-service${deal.mode === 'service' ? ' selected' : ''}`} onClick={() => pick({ mode: 'service' })}>
          {deal.mode === 'service' ? '✓ Служебная бронь — без сделки (ремонт, уборка…)' : 'Служебная бронь без сделки'}
        </button>
      </div>
    </section>
  );

  return (
    <div className="sheet-backdrop" onClick={() => !busy && onClose()}>
      <form
        className="sheet bk"
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
        <header className="bk-head">
          <div>
            <h3>Новая бронь</h3>
            <span className="bk-sub">{[group?.name, context.clientName].filter(Boolean).join(' · ')}</span>
          </div>
          <button type="button" className="bk-close" aria-label="Закрыть" disabled={busy} onClick={onClose}>
            ×
          </button>
        </header>
        {wizard && (
          <ol className="bk-steps">
            {(['deal', 'group', 'details'] as const).map((s, i) => (
              <li key={s} className={s === step ? 'active' : ['deal', 'group', 'details'].indexOf(step) > i ? 'done' : ''}>
                {['Сделка', 'Группа', 'Детали'][i]}
              </li>
            ))}
          </ol>
        )}
        <div className="bk-body">
          {!allowed.length ? (
            <p className="notice error">Нет права создавать брони ни в одной группе.</p>
          ) : (
            <>
              {step === 'deal' && dealBlock}
              {step === 'group' && (
                <section className="bk-section">
                  <h4 className="bk-title">Группа для брони</h4>
                  <div className="bk-choices" role="radiogroup" aria-label="Группа">
                    {groupChoices.map((g) => (
                      <button
                        key={g.id}
                        type="button"
                        role="radio"
                        aria-checked={g.id === groupId}
                        className={`bk-choice${g.id === groupId ? ' selected' : ''}`}
                        onClick={() => chooseGroup(g.id)}
                      >
                        <span className="bk-dot" aria-hidden="true" />
                        <b>{g.name}</b>
                        {dealCategory !== null && g.dealCategoryId === dealCategory && <span className="bk-meta">воронка сделки</span>}
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
                  <section className="bk-section">
                    <h4 className="bk-title">Когда и где</h4>
                    <div className="df-grid">
                      {!wizard && allowed.length > 1 && (
                        <div className="df-row">
                          <label className="df-field">
                            <span className="df-label">Группа</span>
                            <select value={groupId} onChange={(e) => chooseGroup(e.target.value)}>
                              {allowed.map((g) => (
                                <option key={g.id} value={g.id}>
                                  {g.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>
                      )}
                      <div className="df-row">
                        <div className="df-field">
                          <span className="df-label">{resourceRows.length > 1 ? 'Ресурсы' : 'Ресурс'}</span>
                          <div className="bk-resources">
                            {resourceRows.map((rid, i) => (
                              <span key={i} className="df-control">
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
                                  <button type="button" className="df-reset" aria-label="Убрать ресурс" onClick={() => setResourceIds(resourceIds.filter((_, k) => k !== i))}>
                                    ×
                                  </button>
                                )}
                              </span>
                            ))}
                            {resourceIds.length > 0 && freeResources.length > 0 && (
                              <button type="button" className="bk-more" onClick={() => setResourceIds([...resourceIds, freeResources[0].id])}>
                                ＋ ещё ресурс
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
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

                  {!wizard && dealBlock}

                  {deal.mode !== 'service' && (
                    <section className="bk-section">
                      <h4 className="bk-title">Бронь и оплата</h4>
                      <div className="df-grid">
                        <div className="df-row pair">
                          {group && (group.bookingTypes ?? []).length > 0 && (
                            <label className="df-field">
                              <span className="df-label">
                                Тип брони{group.bookingTypeRequired && <i className="df-req">*</i>}
                              </span>
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
                                <small className="df-hint">Не определится по товарам — бронь не создастся.</small>
                              )}
                            </label>
                          )}
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
                        </div>
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
              )}
              {error && (
                <p className="notice error" role="alert">
                  {error}
                </p>
              )}
            </>
          )}
        </div>
        {allowed.length > 0 && (
          <footer className="bk-foot">
            <span className="bk-summary">{step === 'details' ? summary.join(' · ') : 'Товары и цены — в сделке'}</span>
            <span className="bk-actions">
              {step !== 'deal' && wizard && (
                <button type="button" disabled={busy} onClick={() => setStep(step === 'details' ? 'group' : 'deal')}>
                  Назад
                </button>
              )}
              <button type="button" disabled={busy} onClick={onClose}>
                Отмена
              </button>
              <button type="submit" className="primary" disabled={busy || (step === 'group' && !groupChoices.some((g) => g.id === groupId))}>
                {step !== 'details' ? 'Далее' : busy ? 'Создаю…' : 'Создать бронь'}
              </button>
            </span>
          </footer>
        )}
      </form>
    </div>
  );
}
