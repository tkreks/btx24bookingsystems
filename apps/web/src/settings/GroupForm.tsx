import { useState, type FormEvent } from 'react';
import {
  GROUP_FEATURES,
  type GroupDto,
  type GroupFeature,
  type GroupDirectoryDto,
  type GroupSettingsDto,
} from '@btx24/shared';
import { apiDelete, apiPost, apiPut } from '../api.js';
import { MembersEditor } from './MembersEditor.js';
import { groupSettings, newGroup } from './group-form.js';

const FEATURES: Record<GroupFeature, string> = {
  'booking.details': 'Данные броней и сделок',
  'booking.create': 'Создание броней',
  'booking.edit': 'Редактирование броней',
  'booking.cancel': 'Отмена броней',
  'payment.send': 'Отправка ссылок на оплату',
  'openlines.read': 'Чтение открытых линий',
  'openlines.send': 'Отправка сообщений в открытые линии',
};
export function GroupForm({
  group,
  directory,
  onSaved,
  onCancel,
  onDirty,
  onBusy,
}: {
  group: GroupDto | null;
  directory: GroupDirectoryDto | null;
  onSaved: (group: GroupDto | null) => void;
  onCancel: () => void;
  onDirty: (dirty: boolean) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [draft, setDraft] = useState<GroupSettingsDto>(() => (group ? groupSettings(group) : newGroup()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const update = (patch: Partial<GroupSettingsDto>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    onDirty(true);
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    onBusy(true);
    setError('');
    try {
      onSaved(
        group
          ? await apiPut<GroupDto>(`/admin/groups/${encodeURIComponent(group.id)}`, draft)
          : await apiPost<GroupDto>('/admin/groups', draft),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось сохранить группу');
    } finally {
      setBusy(false);
      onBusy(false);
    }
  };
  const archive = async () => {
    if (!group || !confirm(`Архивировать группу «${group.name}»? Она исчезнет из календаря участников.`)) return;
    setBusy(true);
    onBusy(true);
    setError('');
    try {
      await apiDelete(`/admin/groups/${encodeURIComponent(group.id)}`);
      onSaved(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось архивировать группу');
    } finally {
      setBusy(false);
      onBusy(false);
    }
  };
  const missingResources = draft.resourceIds.filter((id) => !directory?.resources.some((r) => r.id === id));
  return (
    <form onSubmit={save} className="settings-form">
      <h3>{group ? 'Настройки группы' : 'Новая группа'}</h3>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      <fieldset disabled={busy}>
        <label>
          Название
          <input required maxLength={100} value={draft.name} onChange={(e) => update({ name: e.target.value })} />
        </label>
        <label>
          Воронка сделок
          <select
            value={draft.dealCategoryId ?? ''}
            onChange={(e) => update({ dealCategoryId: e.target.value === '' ? null : Number(e.target.value) })}
          >
            <option value="">Без привязки</option>
            {draft.dealCategoryId !== null && !directory?.categories.some((c) => c.id === draft.dealCategoryId) && (
              <option value={draft.dealCategoryId}>Воронка #{draft.dealCategoryId} (нет в справочнике)</option>
            )}
            {directory?.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend>Ресурсы</legend>
          {!directory && <p className="muted">Справочник недоступен. Сохранённые ресурсы остаются выбранными.</p>}
          <div className="checkbox-grid">
            {[
              ...(directory?.resources ?? []),
              ...missingResources.map((id) => ({ id, name: `Ресурс #${id} (нет в справочнике)` })),
            ].map((r) => (
              <label className="check" key={r.id}>
                <input
                  type="checkbox"
                  checked={draft.resourceIds.includes(r.id)}
                  onChange={(e) =>
                    update({
                      resourceIds: e.target.checked
                        ? [...draft.resourceIds, r.id]
                        : draft.resourceIds.filter((id) => id !== r.id),
                    })
                  }
                />
                {r.name}
              </label>
            ))}
          </div>
        </fieldset>
        <label>
          Режим бронирования
          <select
            value={draft.bookingMode}
            onChange={(e) => update({ bookingMode: e.target.value as GroupSettingsDto['bookingMode'] })}
          >
            <option value="duration">Часы от клика</option>
            <option value="interval">Заезд / выезд</option>
          </select>
        </label>
        {draft.bookingMode === 'duration' ? (
          <label>
            Минимальная длительность, минут
            <input
              type="number"
              required
              min={1}
              max={10080}
              value={draft.durationMinutes}
              onChange={(e) => update({ durationMinutes: Number(e.target.value) })}
            />
          </label>
        ) : (
          <div className="form-columns">
            <label>
              Заезд
              <input
                type="time"
                required
                value={draft.checkInTime}
                onChange={(e) => update({ checkInTime: e.target.value })}
              />
            </label>
            <label>
              Выезд
              <input
                type="time"
                required
                value={draft.checkOutTime}
                onChange={(e) => update({ checkOutTime: e.target.value })}
              />
            </label>
            <label>
              Ночей по умолчанию
              <input
                type="number"
                required
                min={0}
                max={365}
                value={draft.defaultNights}
                onChange={(e) => update({ defaultNights: Number(e.target.value) })}
              />
            </label>
          </div>
        )}
        <label>
          Техническое окно, минут
          <input
            type="number"
            required
            min={0}
            max={1440}
            value={draft.techWindowMinutes}
            onChange={(e) => update({ techWindowMinutes: Number(e.target.value) })}
          />
        </label>
        <p className="muted">Техническое окно предупреждает о пересечении, но не запрещает бронирование.</p>
        <fieldset>
          <legend>Функции группы</legend>
          {GROUP_FEATURES.map((f) => (
            <label className="check" key={f}>
              <input
                type="checkbox"
                checked={draft.features.includes(f)}
                onChange={(e) =>
                  update({
                    features: e.target.checked ? [...draft.features, f] : draft.features.filter((item) => item !== f),
                  })
                }
              />
              {FEATURES[f]}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Участники и роли</legend>
          {directory && !directory.departmentsAvailable && (
            <p className="notice">
              Список отделов недоступен. Добавьте сотрудников поимённо. Без права department учитываются только прямые
              отделы.
            </p>
          )}
          <MembersEditor
            withRoles
            members={draft.members}
            users={directory?.users}
            departments={directory?.departments ?? []}
            onChange={(members) => update({ members })}
          />
          <p className="muted">
            Роль ограничена включёнными функциями группы. Технолог видит только занятость. Без участников группа
            доступна только администраторам приложения.
          </p>
        </fieldset>
        <div className="form-actions">
          <button className="primary" type="submit">
            {busy ? 'Сохранение…' : 'Сохранить группу'}
          </button>
          <button type="button" onClick={onCancel}>
            Отмена
          </button>
          {group && (
            <button type="button" className="danger" onClick={archive}>
              Архивировать
            </button>
          )}
        </div>
      </fieldset>
    </form>
  );
}
