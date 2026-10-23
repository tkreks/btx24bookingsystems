import { useState } from 'react';
import type { CalendarBooking, CalendarDay, CancelBookingResultDto, DealFormDto } from '@btx24/shared';
import { apiGet, apiPost, apiPut } from '../api.js';
import { openPortalPath } from '../b24.js';
import { DealFieldsEditor, initialValues, useDealFieldValues } from '../bookings/DealFieldsEditor.js';
import { fmtDateTime, fmtMoney } from '../format.js';

export function BookingDetails({
  booking,
  day,
  groupId,
  canEdit,
  canCancel,
  canCreate = false,
  onClose,
  onChanged,
  onCancelled,
  onResolved,
}: {
  booking: CalendarBooking;
  day: CalendarDay;
  /** Группа календаря — по её настройке поля сделки и права на правку. */
  groupId: string | null;
  /** Право `booking.edit` в группе (подсказка; проверяет сервер). */
  canEdit: boolean;
  /** Право `booking.cancel` в группе (подсказка; проверяет сервер). */
  canCancel: boolean;
  onClose: () => void;
  /** Поля сделки сохранены — календарь перечитывает день. */
  onChanged: () => void;
  /** Бронь снята — календарь закрывает карточку, показывает итог и перечитывает день. */
  onCancelled: (r: CancelBookingResultDto) => void;
  /** Право `booking.create` в группе — «Оставить бронь» (создать заново) для брони, удалённой в Битрикс24. */
  canCreate?: boolean;
  /** Решение по брони, удалённой в Битрикс24, принято — итог словами. */
  onResolved?: (note: string) => void;
}) {
  const names = new Map(day.resources.map((r) => [r.id, r.name]));
  // Правка полей сделки: форма с сервера (поля группы и текущие значения) и введённые значения.
  const [editing, setEditing] = useState<{ form: DealFormDto; n: number } | null>(null);
  const editFields = editing?.form.fields ?? [];
  const fieldState = useDealFieldValues(editFields, 'edit', editing ? `edit:${editing.n}` : '');
  // После сохранения показываем свежие значения, пока календарь перечитывает день.
  const [saved, setSaved] = useState<DealFormDto | null>(null);
  const [busy, setBusy] = useState(false);
  // Снятие брони: подтверждение и причина (необязательно).
  const [cancelling, setCancelling] = useState<{ comment: string } | null>(null);
  const [error, setError] = useState('');
  const openDeal = () => {
    if (booking.dealId) openPortalPath(`/crm/deal/details/${booking.dealId}/`);
  };
  const editable = canEdit && !!groupId && !!booking.deal;

  const startEdit = async () => {
    setBusy(true);
    setError('');
    try {
      const form = await apiGet<DealFormDto>(`/deal-form?groupId=${encodeURIComponent(groupId!)}&dealId=${booking.dealId}&purpose=edit`);
      // Каждое открытие правки — свежие значения сделки (ключ состояния полей).
      setEditing({ form, n: Date.now() });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить поля сделки');
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!editing) return;
    const before = initialValues(editing.form.fields);
    const changed = Object.fromEntries(Object.entries(fieldState.values).filter(([code, v]) => v !== before[code]));
    const missing = editing.form.fields.find((f) => f.required && !f.readOnly && !fieldState.values[f.code]?.trim());
    if (missing) return setError(`Заполните поле «${missing.label}»`);
    if (!Object.keys(changed).length) return setEditing(null);
    setBusy(true);
    setError('');
    try {
      const form = await apiPut<DealFormDto>(`/deals/${booking.dealId}/fields`, { groupId, values: changed });
      setSaved(form);
      setEditing(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось сохранить сделку');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!cancelling || !groupId) return;
    setBusy(true);
    setError('');
    try {
      const r = await apiPost<CancelBookingResultDto>(`/bookings/${booking.id}/cancel`, {
        groupId,
        ...(cancelling.comment.trim() ? { comment: cancelling.comment.trim() } : {}),
      });
      onCancelled(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось снять бронь');
      setBusy(false);
    }
  };

  // Бронь удалена в Битрикс24: оставить (создать заново по данным приложения) или удалить из приложения.
  const decide = async (what: 'recreate' | 'remove-in-app') => {
    const text =
      what === 'recreate'
        ? 'Оставить бронь? Она будет создана в Битрикс24 заново на то же время и ресурс, у брони будет новый номер.'
        : 'Удалить бронь из приложения? В истории останется запись об удалении.';
    if (!confirm(text)) return;
    setBusy(true);
    setError('');
    try {
      await apiPost(`/bookings/${booking.id}/${what}`, {});
      onResolved?.(what === 'recreate' ? `Бронь #${booking.id} оставлена — создана в Битрикс24 заново.` : `Бронь #${booking.id} удалена из приложения.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось выполнить действие');
      setBusy(false);
    }
  };

  const viewFields = saved
    ? saved.fields.filter((f) => f.showView && f.display).map((f) => ({ code: f.code, label: f.label, value: f.display }))
    : booking.fields.filter((f) => f.inView);

  return (
    <div className="sheet-backdrop" onClick={() => !busy && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={booking.name || 'Бронь'} onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{booking.name || 'Бронь'}</h2>
          <button aria-label="Закрыть" disabled={busy} onClick={onClose}>
            ×
          </button>
        </header>
        {booking.missing && (
          <div className="missing-decision" role="alert">
            <b>Бронь удалена в Битрикс24 — нужно решение</b>
            <span className="muted">
              В приложении она остаётся, пока вы не решите, что с ней делать. Слот в Битрикс24 сейчас свободен. «Оставить» — бронь снова
              создаётся в Битрикс24 на это же время и ресурс (со связью со сделкой); «Удалить из приложения» — бронь уходит в историю как
              удалённая.
            </span>
            <div className="form-actions">
              <button className="primary" disabled={busy || !canCreate} onClick={() => void decide('recreate')}>
                Оставить бронь
              </button>
              <button className="danger-outline" disabled={busy || !canCancel} onClick={() => void decide('remove-in-app')}>
                Удалить из приложения
              </button>
            </div>
            {error && <p className="notice error">{error}</p>}
          </div>
        )}
        <dl>
          <dt>Время</dt>
          <dd>
            {fmtDateTime(booking.start, day.timezone)} — {fmtDateTime(booking.end, day.timezone)}
          </dd>
          <dt>Ресурс</dt>
          <dd>{booking.resourceIds.map((id) => names.get(id) ?? `#${id}`).join(', ')}</dd>
          {!editing && viewFields.map((f) => <Field key={f.code} label={f.label} value={f.value} />)}
          {booking.description && (
            <>
              <dt>Описание</dt>
              <dd>{booking.description}</dd>
            </>
          )}
          <dt>Сделка</dt>
          <dd>
            {booking.deal ? (
              <>
                <button className="link" onClick={openDeal}>
                  #{booking.deal.id} {booking.deal.title}
                </button>
                {booking.deal.opportunity ? (
                  <div className="muted">{fmtMoney(booking.deal.opportunity, booking.deal.currency)}</div>
                ) : null}
              </>
            ) : booking.dealId ? (
              <span className="muted">#{booking.dealId} — нет доступа к сделке</span>
            ) : (
              <span className="muted">не привязана</span>
            )}
          </dd>
        </dl>
        {editing && (
          <form
            className="deal-edit"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            {editing.form.fields.length ? (
              <DealFieldsEditor
                fields={editing.form.fields}
                values={fieldState.values}
                auto={fieldState.auto}
                onChange={fieldState.set}
                onResetFormula={fieldState.resetFormula}
              />
            ) : (
              <p className="muted">В группе не настроены поля сделки (⚙ → группа → «Поля сделки»).</p>
            )}
            {error && (
              <p className="notice error" role="alert">
                {error}
              </p>
            )}
            <div className="form-actions">
              <button type="submit" className="primary" disabled={busy}>
                {busy ? 'Сохраняю…' : 'Сохранить'}
              </button>
              <button type="button" disabled={busy} onClick={() => (setEditing(null), setError(''))}>
                Отмена
              </button>
            </div>
          </form>
        )}
        {cancelling && (
          <div className="cancel-confirm" role="group" aria-label="Снять бронь">
            <b>Снять бронь?</b>
            <span className="muted">Бронь удалится из календаря и из Битрикс24, слот освободится. В истории брони останется запись.</span>
            <textarea
              rows={2}
              maxLength={500}
              placeholder="Причина (необязательно)"
              value={cancelling.comment}
              onChange={(e) => setCancelling({ comment: e.target.value })}
            />
            <div className="form-actions">
              <button type="button" className="danger" disabled={busy} onClick={() => void cancel()}>
                {busy ? 'Снимаю…' : 'Да, снять бронь'}
              </button>
              <button type="button" disabled={busy} onClick={() => (setCancelling(null), setError(''))}>
                Не снимать
              </button>
            </div>
          </div>
        )}
        {!editing && !booking.missing && error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        {!booking.missing && !editing && !cancelling && (editable || (canCancel && !!groupId)) && (
          <div className="form-actions">
            {editable && (
              <button className="primary" disabled={busy} onClick={() => void startEdit()}>
                {busy ? 'Загрузка…' : 'Редактировать'}
              </button>
            )}
            {canCancel && groupId && (
              <button className="danger-outline" disabled={busy} onClick={() => (setCancelling({ comment: '' }), setError(''))}>
                Снять бронь
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
