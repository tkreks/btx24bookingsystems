import { useState } from 'react';
import type { CalendarBooking, CalendarDay, DealFormDto } from '@btx24/shared';
import { apiGet, apiPut } from '../api.js';
import { DealFieldsEditor, initialValues } from '../bookings/DealFieldsEditor.js';
import { fmtDateTime, fmtMoney } from '../format.js';

export function BookingDetails({
  booking,
  day,
  groupId,
  canEdit,
  onClose,
  onChanged,
}: {
  booking: CalendarBooking;
  day: CalendarDay;
  /** Группа календаря — по её настройке поля сделки и права на правку. */
  groupId: string | null;
  /** Право `booking.edit` в группе (подсказка; проверяет сервер). */
  canEdit: boolean;
  onClose: () => void;
  /** Поля сделки сохранены — календарь перечитывает день. */
  onChanged: () => void;
}) {
  const names = new Map(day.resources.map((r) => [r.id, r.name]));
  // Правка полей сделки: форма с сервера (поля группы и текущие значения) и введённые значения.
  const [editing, setEditing] = useState<{ form: DealFormDto; values: Record<string, string> } | null>(null);
  // После сохранения показываем свежие значения, пока календарь перечитывает день.
  const [saved, setSaved] = useState<DealFormDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const openDeal = () => {
    if (booking.dealId) window.BX24?.openPath?.(`/crm/deal/details/${booking.dealId}/`);
  };
  const editable = canEdit && !!groupId && !!booking.deal;

  const startEdit = async () => {
    setBusy(true);
    setError('');
    try {
      const form = await apiGet<DealFormDto>(`/deal-form?groupId=${encodeURIComponent(groupId!)}&dealId=${booking.dealId}`);
      setEditing({ form, values: initialValues(form.fields) });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить поля сделки');
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!editing) return;
    const before = initialValues(editing.form.fields);
    const changed = Object.fromEntries(Object.entries(editing.values).filter(([code, v]) => v !== before[code]));
    const missing = editing.form.fields.find((f) => f.required && !f.readOnly && !editing.values[f.code]?.trim());
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
                values={editing.values}
                onChange={(code, v) => setEditing((prev) => prev && { ...prev, values: { ...prev.values, [code]: v } })}
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
        {!editing && editable && (
          <>
            {error && (
              <p className="notice error" role="alert">
                {error}
              </p>
            )}
            <div className="form-actions">
              <button className="primary" disabled={busy} onClick={() => void startEdit()}>
                {busy ? 'Загрузка…' : 'Редактировать'}
              </button>
            </div>
          </>
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
