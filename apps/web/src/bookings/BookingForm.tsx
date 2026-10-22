import { useEffect, useMemo, useState } from 'react';
import {
  canUsePaymentMode,
  PAYMENT_MODE_LABELS,
  PAYMENT_MODES,
  type CalendarDay,
  type CreateBookingResultDto,
  type MyGroupDto,
  type PaymentMode,
} from '@btx24/shared';
import { apiGet, apiPost } from '../api.js';
import { defaultPeriod, periodToUtc, type PeriodFields } from './booking-form.js';

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
  const deals = context.openDeals ?? [];
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
  const chooseGroup = (id: string) => {
    setGroupId(id);
    const g = allowed.find((x) => x.id === id);
    if (g) setPeriod(defaultPeriod(g, period.startDate, period.startTime));
    setResourceIds((prev) => prev.filter((r) => g?.resourceIds.includes(r)));
    // Другая группа — другие права: недоступный выбор сбрасывается.
    if (deal.mode === 'new' && !g?.permissions.includes('deal.create')) setDeal({ mode: 'service' });
    if (!PAYMENT_MODES.filter((m) => canUsePaymentMode(g?.permissions ?? [], m)).includes(paymentMode)) setPaymentMode('prepayment');
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
        guests: guests ? Number(guests) : null,
        comment: comment.trim() || undefined,
        paymentMode,
      });
      onDone(r, deal.mode === 'service' ? null : paymentMode);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось создать бронь');
    } finally {
      setBusy(false);
    }
  };

  const dealBlock = (
            <fieldset className="form-deal">
              <legend>{wizard ? 'По какой сделке бронь?' : 'Сделка'}</legend>
              {context.dealId && !deals.some((d) => d.id === context.dealId) && (
                <label className="check">
                  <input type="radio" name="deal" checked={deal.mode === 'existing' && deal.dealId === context.dealId} onChange={() => setDeal({ mode: 'existing', dealId: context.dealId! })} />
                  Эта сделка #{context.dealId}
                </label>
              )}
              {deals.map((d) => (
                <label key={d.id} className="check">
                  <input type="radio" name="deal" checked={deal.mode === 'existing' && deal.dealId === d.id} onChange={() => setDeal({ mode: 'existing', dealId: d.id })} />
                  {d.title} <span className="muted">#{d.id}</span>
                </label>
              ))}
              {(wizard ? anyNewDeal : canNewDeal) && (
                <label className="check">
                  <input type="radio" name="deal" checked={deal.mode === 'new'} onChange={() => setDeal({ mode: 'new', title: context.clientName ?? '' })} />
                  Новая сделка
                </label>
              )}
              {deal.mode === 'new' && (
                <input
                  aria-label="Название новой сделки"
                  placeholder="Название сделки"
                  value={deal.title}
                  maxLength={255}
                  onChange={(e) => setDeal({ mode: 'new', title: e.target.value })}
                />
              )}
              <label className="check">
                <input type="radio" name="deal" checked={deal.mode === 'service'} onChange={() => setDeal({ mode: 'service' })} />
                Служебная бронь (без сделки — ремонт, уборка…)
              </label>
            </fieldset>
  );

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
              <fieldset className="form-groups">
                <legend>Группа для брони</legend>
                {groupChoices.map((g) => (
                  <label key={g.id} className={`group-choice${g.id === groupId ? ' selected' : ''}`}>
                    <input type="radio" name="group" checked={g.id === groupId} onChange={() => chooseGroup(g.id)} />
                    <b>{g.name}</b>
                    {dealCategory !== null && g.dealCategoryId === dealCategory && <span className="muted"> · воронка сделки</span>}
                  </label>
                ))}
                {!groupChoices.length && <p className="notice error">Нет групп, где вам можно создать такую бронь.</p>}
              </fieldset>
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
            <div className="settings-grid">
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

            <fieldset className="form-resources">
              <legend>Ресурсы</legend>
              {!list && <span className="muted">Загрузка…</span>}
              {list?.map((r) => (
                <label key={r.id} className="check">
                  <input
                    type="checkbox"
                    checked={resourceIds.includes(r.id)}
                    onChange={(e) => setResourceIds(e.target.checked ? [...resourceIds, r.id] : resourceIds.filter((x) => x !== r.id))}
                  />
                  {r.name}
                </label>
              ))}
            </fieldset>

            {!wizard && dealBlock}

            <div className="settings-grid">
              {deal.mode !== 'service' && (
                <>
                  <label>
                    Гостей
                    <input type="number" min={0} max={1000} value={guests} onChange={(e) => setGuests(e.target.value)} />
                  </label>
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
                </>
              )}
            </div>
            <label className="settings-block">
              Комментарий
              <textarea rows={2} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />
            </label>
            <p className="muted">Товары и цены — в сделке; тип брони и сообщение клиенту приложение определит по товарам.</p>
            </>
            )}
            {error && (
              <p className="notice error" role="alert">
                {error}
              </p>
            )}
            <div className="form-actions">
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
            </div>
          </>
        )}
      </form>
    </div>
  );
}
