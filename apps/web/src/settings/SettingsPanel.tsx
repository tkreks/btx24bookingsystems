import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSettingsDto, GroupDirectoryDto, GroupDto } from '@btx24/shared';
import { apiGet, apiPut } from '../api.js';
import { fitFrame } from '../b24.js';
import { PlacementSettings } from '../calendar/AdminPanel.js';
import { BookingSyncSettings } from '../bookings/BookingSyncSettings.js';
import { FieldsSection } from './FieldsSection.js';
import { AppSettingsForm } from './AppSettingsForm.js';
import { ResourceNames } from './ResourceNames.js';
import { SettingsCodes } from './SettingsCodes.js';
import { fmtDateTime } from '../format.js';
import { ExternalPasswords } from './ExternalPasswords.js';
import { GroupForm } from './GroupForm.js';
import { MessengersSection } from './MessengersSection.js';

type Tab = 'groups' | 'resources' | 'app' | 'passwords' | 'placements' | 'messengers' | 'fields';
const TABS: { key: Tab; label: string }[] = [
  { key: 'groups', label: 'Группы' },
  { key: 'resources', label: 'Ресурсы' },
  { key: 'app', label: 'Приложение' },
  { key: 'passwords', label: 'Прямая ссылка' },
  { key: 'placements', label: 'Встройки' },
  { key: 'messengers', label: 'Мессенджеры' },
  { key: 'fields', label: 'Поля' },
];
/** Настройки — отдельная страница (решение владельца 2026-10-24), а не окно поверх дашборда. */
export function SettingsPanel({
  onClose,
  onChanged,
  timezone,
  temporary = null,
}: {
  onClose: () => void;
  onChanged: () => void;
  timezone: string;
  /** Доступ по временному паролю — до этого времени (ISO); null — постоянный администратор. */
  temporary?: string | null;
}) {
  const [tab, setTab] = useState<Tab>('groups');
  const [groups, setGroups] = useState<GroupDto[] | null>(null);
  const [settings, setSettings] = useState<AppSettingsDto | null>(null);
  const [directory, setDirectory] = useState<GroupDirectoryDto | null>(null);
  const [error, setError] = useState('');
  const [directoryError, setDirectoryError] = useState('');
  const [editing, setEditing] = useState<GroupDto | 'new' | null>(null);
  const [saved, setSaved] = useState('');
  const dirty = useRef(false);
  const saving = useRef(false);
  const [busy, setBusy] = useState(false);
  const markBusy = (value: boolean) => {
    saving.current = value;
    setBusy(value);
  };
  const canLeave = useCallback(
    () => !saving.current && (!dirty.current || confirm('Есть несохранённые изменения. Закрыть без сохранения?')),
    [],
  );
  const close = useCallback(() => {
    if (canLeave()) onClose();
  }, [canLeave, onClose]);
  useEffect(() => {
    let active = true;
    void Promise.all([apiGet<GroupDto[]>('/admin/groups'), apiGet<AppSettingsDto>('/admin/settings')]).then(
      ([g, s]) => {
        if (active) {
          setGroups(g);
          setSettings(s);
        }
      },
      (e) => {
        if (active) setError(e instanceof Error ? e.message : 'Не удалось загрузить настройки');
      },
    );
    void apiGet<GroupDirectoryDto>('/admin/group-directory').then(
      (d) => {
        if (active) setDirectory(d);
      },
      (e) => {
        if (active) setDirectoryError(e instanceof Error ? e.message : 'Не удалось загрузить справочники');
      },
    );
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => fitFrame(), [tab, groups, editing]);
  const refreshDirectory = () => {
    void apiGet<GroupDirectoryDto>('/admin/group-directory').then(
      (value) => {
        setDirectory(value);
        setDirectoryError('');
      },
      (e) => setDirectoryError(e instanceof Error ? e.message : 'Не удалось обновить справочники'),
    );
  };
  const markDirty = (value: boolean) => {
    dirty.current = value;
    setSaved('');
  };
  return (
    <div className="page settings-page">
        <header className="toolbar">
          <div className="toolbar-title">
            <button aria-label="Назад" disabled={busy} onClick={close}>
              ‹
            </button>
            <h1 id="settings-title">Настройки</h1>
          </div>
        </header>
        <nav className="settings-tabs" aria-label="Разделы настроек">
          {TABS.map((t) => (
            <button
              disabled={busy}
              key={t.key}
              aria-current={tab === t.key ? 'page' : undefined}
              className={tab === t.key ? 'active' : ''}
              onClick={() => {
                if (tab !== t.key && canLeave()) {
                  dirty.current = false;
                  setTab(t.key);
                  setEditing(null);
                  setSaved('');
                }
              }}
            >
              {t.label}
            </button>
          ))}
        </nav>
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        {directoryError && (
          <div className="notice error" role="alert">
            Справочники: {directoryError}. Сохранённые связи доступны по ID.
          </div>
        )}
        {saved && (
          <div className="notice" role="status">
            {saved}
          </div>
        )}
        {tab === 'groups' &&
          (groups === null ? (
            !error && <p>Загрузка групп…</p>
          ) : editing !== null ? (
            <GroupForm
              key={editing === 'new' ? 'new' : editing.id}
              group={editing === 'new' ? null : editing}
              directory={directory}
              onDirty={markDirty}
              onBusy={markBusy}
              onCancel={() => {
                if (canLeave()) {
                  dirty.current = false;
                  setEditing(null);
                }
              }}
              onSaved={(group) => {
                setGroups((prev) =>
                  group
                    ? prev?.some((g) => g.id === group.id)
                      ? prev.map((g) => (g.id === group.id ? group : g))
                      : [...(prev ?? []), group]
                    : (prev ?? []).filter((g) => editing === 'new' || g.id !== editing.id),
                );
                dirty.current = false;
                setEditing(null);
                setSaved(group ? 'Группа сохранена.' : 'Группа архивирована.');
                onChanged();
                refreshDirectory();
              }}
            />
          ) : (
            <section>
              <div className="form-actions">
                <h3>Группы</h3>
                <button
                  className="primary"
                  onClick={() => {
                    setEditing('new');
                    setSaved('');
                  }}
                >
                  Создать группу
                </button>
              </div>
              {groups.length === 0 && (
                <p className="muted">
                  Создайте группу и назначьте участников, чтобы сотрудники получили доступ к календарю.
                </p>
              )}
              <ul className="settings-groups">
                {groups.map((g, i) => (
                  <li key={g.id}>
                    {/* Порядок групп — в мастере брони и календаре такой же. */}
                    <span className="group-order" role="group" aria-label={`Порядок группы «${g.name}»`}>
                      {([-1, 1] as const).map((dir) => (
                        <button
                          key={dir}
                          type="button"
                          aria-label={dir < 0 ? 'Выше' : 'Ниже'}
                          title={dir < 0 ? 'Выше' : 'Ниже'}
                          disabled={i + dir < 0 || i + dir >= groups.length}
                          onClick={() => {
                            const ids = groups.map((x) => x.id);
                            [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
                            apiPut<GroupDto[]>('/admin/groups-order', { ids }).then(setGroups, (e) => setError(e instanceof Error ? e.message : 'Не удалось изменить порядок'));
                          }}
                        >
                          {dir < 0 ? '↑' : '↓'}
                        </button>
                      ))}
                    </span>
                    <div>
                      <strong>{g.name}</strong>
                      <p className="muted">
                        Ресурсов: {g.resourceIds.length} · Полей: {g.options?.dealFields.length ?? 0} · Участников:{' '}
                        {g.members.length}
                      </p>
                      {g.members.length === 0 && (
                        <span className="muted">Доступна только администраторам приложения</span>
                      )}
                    </div>
                    <button
                      onClick={() => {
                        setEditing(g);
                        setSaved('');
                      }}
                    >
                      Настроить
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        {temporary && (
          <div className="notice">
            Временный доступ к настройкам до {fmtDateTime(temporary, timezone)}. Список администраторов и сбор данных
            меняют только постоянные администраторы.
          </div>
        )}
        {tab === 'app' && settings && !temporary && (
          <AppSettingsForm
            settings={settings}
            users={directory?.users ?? []}
            departments={directory?.departments ?? []}
            onDirty={markDirty}
            onBusy={markBusy}
            onSaved={(s) => {
              setSettings(s);
              onChanged();
              refreshDirectory();
            }}
          />
        )}
        {tab === 'app' && <BookingSyncSettings timezone={timezone} />}
        {tab === 'fields' && <FieldsSection users={directory?.users ?? []} onDirty={markDirty} onBusy={markBusy} onChanged={onChanged} readOnly={!!temporary} />}
        {tab === 'app' && !temporary && <SettingsCodes timezone={timezone} />}
        {tab === 'passwords' && (
          <fieldset className="password-settings" disabled={busy}>
            <ExternalPasswords onDirty={markDirty} onBusy={markBusy} />
          </fieldset>
        )}
        {tab === 'resources' && <ResourceNames />}
        {tab === 'placements' && <PlacementSettings />}
        {tab === 'messengers' && <MessengersSection timezone={timezone} />}
    </div>
  );
}
