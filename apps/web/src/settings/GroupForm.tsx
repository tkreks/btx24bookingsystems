import { useState, type FormEvent } from 'react';
import {
  GROUP_FEATURES,
  type CalendarViewSetting,
  type GroupDto,
  type GroupFeature,
  type GroupDirectoryDto,
  type GroupOptionsDto,
  type GroupSettingsDto,
} from '@btx24/shared';
import { apiDelete, apiPost, apiPut } from '../api.js';
import { MembersEditor } from './MembersEditor.js';
import { CatalogSection, DealFieldsSection, PaymentsSection, ResourcesSection, Section } from './GroupOptions.js';
import { BookingTypesSection } from './BookingTypesSection.js';
import { defaultOptions, groupSettings, newGroup } from './group-form.js';
import { useGroupReferences } from './references.js';

const FEATURES: Record<GroupFeature, string> = {
  'booking.details': 'Данные броней и сделок',
  'booking.create': 'Создание броней',
  'deal.create': 'Создание сделок (вместе с бронями — «Бесплатно» и «Без предоплаты»)',
  'booking.edit': 'Редактирование броней',
  'booking.cancel': 'Отмена броней',
  'payment.send': 'Отправка ссылок на оплату',
  'openlines.read': 'Чтение открытых линий',
  'openlines.send': 'Отправка сообщений в открытые линии',
};

const VIEW_OPTIONS: { value: CalendarViewSetting; label: string }[] = [
  { value: '', label: 'Авто' },
  { value: 'calendar', label: 'Календарь' },
  { value: 'list', label: 'Список' },
  { value: 'availability', label: 'Доступность' },
];

/** Настройки группы — блоки как в прототипе («Настройка групп»), плюс участники и функции. */
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
  const refs = useGroupReferences(draft.dealCategoryId);
  const options = draft.options ?? defaultOptions();
  const update = (patch: Partial<GroupSettingsDto>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    onDirty(true);
  };
  const updateOptions = (patch: Partial<GroupOptionsDto>) => {
    setDraft((prev) => ({ ...prev, options: { ...(prev.options ?? defaultOptions()), ...patch } }));
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
  const resources = [
    ...(directory?.resources ?? []),
    ...missingResources.map((id) => ({ id, name: `Ресурс #${id} (нет в справочнике)` })),
  ];
  const view = (key: 'desktop' | 'mobile', label: string) => (
    <label>
      {label}
      <select
        value={options.views[key]}
        onChange={(e) => updateOptions({ views: { ...options.views, [key]: e.target.value as CalendarViewSetting } })}
      >
        {VIEW_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <form onSubmit={save} className="settings-form">
      <h3>{group ? `Группа «${group.name}»` : 'Новая группа'}</h3>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      <fieldset disabled={busy}>
        <Section title="Основные настройки">
          <div className="settings-grid">
            <label className="wide">
              Название группы
              <input required maxLength={100} value={draft.name} onChange={(e) => update({ name: e.target.value })} />
            </label>
            <label className="wide">
              Канбан сделки
              <select
                value={draft.dealCategoryId ?? ''}
                onChange={(e) => update({ dealCategoryId: e.target.value === '' ? null : Number(e.target.value) })}
              >
                <option value="">Не привязывать</option>
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
            <label>
              Тип расчёта времени
              <select
                value={draft.bookingMode}
                onChange={(e) => update({ bookingMode: e.target.value as GroupSettingsDto['bookingMode'] })}
              >
                <option value="duration">+ часы от клика</option>
                <option value="interval">Интервал заезд/выезд</option>
              </select>
            </label>
            {draft.bookingMode === 'duration' ? (
              <label>
                Минимум часов
                <input
                  type="number"
                  required
                  min={0.5}
                  max={168}
                  step={0.5}
                  value={draft.durationMinutes / 60}
                  onChange={(e) => update({ durationMinutes: Math.round(Number(e.target.value) * 60) })}
                />
              </label>
            ) : (
              <>
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
                  Минимум дней
                  <input
                    type="number"
                    required
                    min={0}
                    max={365}
                    value={draft.defaultNights}
                    onChange={(e) => update({ defaultNights: Number(e.target.value) })}
                  />
                </label>
              </>
            )}
            <label>
              Тех. окно, минут
              <input
                type="number"
                required
                min={0}
                max={1440}
                step={5}
                value={draft.techWindowMinutes}
                onChange={(e) => update({ techWindowMinutes: Number(e.target.value) })}
              />
            </label>
            {view('desktop', 'Вид на ПК')}
            {view('mobile', 'Вид на телефоне')}
          </div>
          <p className="muted">Тех. окно предупреждает о пересечении, но не запрещает бронирование.</p>
        </Section>

        <BookingTypesSection
          rules={options.bookingTypes ?? []}
          onChange={(bookingTypes) => updateOptions({ bookingTypes })}
        />

        <PaymentsSection
          payments={options.payments}
          stages={refs.stages}
          onChange={(payments) => updateOptions({ payments })}
        />

        <ResourcesSection
          resources={resources}
          resourceIds={draft.resourceIds}
          defaults={options.resourceDefaults}
          catalog={refs.catalog}
          onResources={(resourceIds) => update({ resourceIds })}
          onDefaults={(resourceDefaults) => updateOptions({ resourceDefaults })}
        />
        {!directory && (
          <p className="muted">Справочник ресурсов недоступен. Сохранённые ресурсы остаются выбранными.</p>
        )}

        <CatalogSection
          selected={options.productSectionIds}
          catalog={refs.catalog}
          onChange={(productSectionIds) => updateOptions({ productSectionIds })}
        />

        <DealFieldsSection
          fields={options.dealFields}
          available={refs.fields}
          onChange={(dealFields) => updateOptions({ dealFields })}
        />

        <Section title="Участники и роли" hint={`участников: ${draft.members.length}`}>
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
            Роль ограничена включёнными функциями группы. Без участников группа доступна только администраторам
            приложения.
          </p>
        </Section>

        <Section title="Функции группы" open={false}>
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
        </Section>

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
