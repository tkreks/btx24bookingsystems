import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSettingsDto, GroupDirectoryDto, GroupDto } from '@btx24/shared';
import { apiGet } from '../api.js';
import { fitFrame } from '../b24.js';
import { PlacementSettings } from '../calendar/AdminPanel.js';
import { BookingSyncSettings } from '../bookings/BookingSyncSettings.js';
import { DealFieldMapSettings } from '../bookings/DealFieldMapSettings.js';
import { AppSettingsForm } from './AppSettingsForm.js';
import { ResourceNames } from './ResourceNames.js';
import { SettingsCodes } from './SettingsCodes.js';
import { fmtDateTime } from '../format.js';
import { ExternalPasswords } from './ExternalPasswords.js';
import { GroupForm } from './GroupForm.js';

type Tab = 'groups' | 'resources' | 'app' | 'passwords' | 'placements';
const TABS: { key: Tab; label: string }[] = [
  { key: 'groups', label: 'Группы' },
  { key: 'resources', label: 'Ресурсы' },
  { key: 'app', label: 'Приложение' },
  { key: 'passwords', label: 'Прямая ссылка' },
  { key: 'placements', label: 'Встройки' },
];
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
  const dialog = useRef<HTMLDivElement>(null);
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
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.focus();
    const keydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
      if (e.key === 'Tab') {
        const items = dialog.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
        );
        if (!items?.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('keydown', keydown);
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [close]);
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
    <div className="sheet-backdrop" onClick={close}>
      <div
        ref={dialog}
        tabIndex={-1}
        className="sheet settings-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h2 id="settings-title">Настройки</h2>
          <button aria-label="Закрыть настройки" disabled={busy} onClick={close}>
            ×
          </button>
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
                {groups.map((g) => (
                  <li key={g.id}>
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
        {tab === 'app' && <DealFieldMapSettings />}
        {tab === 'app' && !temporary && <SettingsCodes timezone={timezone} />}
        {tab === 'passwords' && (
          <fieldset className="password-settings" disabled={busy}>
            <ExternalPasswords onDirty={markDirty} onBusy={markBusy} />
          </fieldset>
        )}
        {tab === 'resources' && <ResourceNames />}
        {tab === 'placements' && <PlacementSettings />}
      </div>
    </div>
  );
}
