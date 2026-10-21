import { useState, type FormEvent } from 'react';
import type { AppSettingsDto, NamedBitrixItem } from '@btx24/shared';
import { apiPut } from '../api.js';
import { MembersEditor } from './MembersEditor.js';

export function AppSettingsForm({
  settings,
  departments,
  users,
  onSaved,
  onDirty,
  onBusy,
}: {
  settings: AppSettingsDto;
  departments: NamedBitrixItem[];
  users: NamedBitrixItem[];
  onSaved: (s: AppSettingsDto) => void;
  onDirty: (dirty: boolean) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [draft, setDraft] = useState(settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const update = (patch: Partial<AppSettingsDto>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    setSaved(false);
    onDirty(true);
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    onBusy(true);
    setError('');
    try {
      const result = await apiPut<AppSettingsDto>('/admin/settings', draft);
      setDraft(result);
      onSaved(result);
      setSaved(true);
      onDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось сохранить настройки');
    } finally {
      setBusy(false);
      onBusy(false);
    }
  };
  return (
    <form className="settings-form" onSubmit={save}>
      <h3>Настройки приложения</h3>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {saved && (
        <p className="notice" role="status">
          Настройки сохранены.
        </p>
      )}
      <fieldset disabled={busy}>
        <fieldset>
          <legend>Администраторы приложения</legend>
          <p className="muted">Управляют всеми группами. Администраторы портала имеют доступ всегда.</p>
          <MembersEditor
            members={draft.admins}
            users={users}
            departments={departments}
            onChange={(members) => update({ admins: members.map(({ kind, bitrixId }) => ({ kind, bitrixId })) })}
          />
        </fieldset>
        <fieldset>
          <legend>Сбор данных открытых линий</legend>
          <label className="check">
            <input
              type="checkbox"
              checked={draft.dialogMetadataEnabled}
              onChange={(e) =>
                update({
                  dialogMetadataEnabled: e.target.checked,
                  ...(!e.target.checked ? { dialogTextsEnabled: false } : {}),
                })
              }
            />
            Собирать метаданные диалогов
          </label>
          <p className="muted">Время последних сообщений клиента и оператора.</p>
          <label className="check">
            <input
              type="checkbox"
              disabled={!draft.dialogMetadataEnabled}
              checked={draft.dialogTextsEnabled}
              onChange={(e) => update({ dialogTextsEnabled: e.target.checked })}
            />
            Собирать тексты сообщений
          </label>
          <p className="muted">Тексты могут содержать персональные данные клиентов.</p>
        </fieldset>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.removeWazzupEmail}
            onChange={(e) => update({ removeWazzupEmail: e.target.checked })}
          />
          Удалять e-mail с «wazzup» у контакта перед оплатой
        </label>
        <button className="primary" type="submit">
          {busy ? 'Сохранение…' : 'Сохранить настройки'}
        </button>
      </fieldset>
    </form>
  );
}
