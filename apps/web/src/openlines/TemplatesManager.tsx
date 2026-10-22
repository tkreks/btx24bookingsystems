import { useState } from 'react';
import type { MessageTemplateDto, SaveTemplateDto } from '@btx24/shared';
import { apiDelete, apiPost, apiPut } from '../api.js';
import { isEmpty, newStep, toSteps, type ChainStep } from './chain.js';
import { StepsEditor } from './StepsEditor.js';

type Editing = { id: string | null; name: string; steps: ChainStep[]; shared: boolean };

/**
 * Шаблоны сообщений: свои и общие (общие меняют администраторы приложения). Окно в чате или
 * встроенный блок страницы «Шаблоны» (`embedded`).
 */
export function TemplatesManager({
  templates,
  onChanged,
  onClose,
  initial,
  admin = false,
  embedded = false,
}: {
  templates: MessageTemplateDto[];
  onChanged: (templates: MessageTemplateDto[]) => void;
  onClose: () => void;
  /** Открыть сразу на создании шаблона из текущей цепочки. */
  initial?: ChainStep[];
  /** Администратор приложения — может создавать и менять общие шаблоны. */
  admin?: boolean;
  embedded?: boolean;
}) {
  const [editing, setEditing] = useState<Editing | null>(initial ? { id: null, name: '', steps: initial, shared: false } : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    if (!editing) return;
    const body: SaveTemplateDto = { name: editing.name, steps: toSteps(editing.steps), ...(admin ? { shared: editing.shared } : {}) };
    setBusy(true);
    setError('');
    try {
      const saved = editing.id
        ? await apiPut<MessageTemplateDto>(`/openlines/templates/${editing.id}`, body)
        : await apiPost<MessageTemplateDto>('/openlines/templates', body);
      onChanged(
        [...templates.filter((t) => t.id !== saved.id), saved].sort((a, b) => Number(b.shared) - Number(a.shared) || a.name.localeCompare(b.name, 'ru')),
      );
      setEditing(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось сохранить шаблон');
    } finally {
      setBusy(false);
    }
  };
  const remove = async (t: MessageTemplateDto) => {
    if (!confirm(`Удалить шаблон «${t.name}»?`)) return;
    setBusy(true);
    try {
      await apiDelete(`/openlines/templates/${t.id}`);
      onChanged(templates.filter((x) => x.id !== t.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось удалить шаблон');
    } finally {
      setBusy(false);
    }
  };

  const body = (
    <>
        {!embedded && (
        <header>
          <h2 id="templates-title">{editing ? (editing.id ? 'Шаблон' : 'Новый шаблон') : 'Шаблоны'}</h2>
          <button aria-label="Закрыть шаблоны" onClick={onClose}>
            ×
          </button>
        </header>
        )}
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        {editing ? (
          <form
            className="settings-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label>
              Название
              <input
                required
                maxLength={100}
                value={editing.name}
                placeholder="Например: Приветствие и прайс"
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </label>
            {admin && (
              <label className="check">
                <input type="checkbox" checked={editing.shared} onChange={(e) => setEditing({ ...editing, shared: e.target.checked })} />
                Общий шаблон — видят все сотрудники
              </label>
            )}
            <p className="muted">
              Сообщения уйдут по порядку, файлы — отдельными сообщениями после текста. Переменные ({'{{Дата начала визита}}'}, {'{{Контакт: Имя}}'},{' '}
              {'{=Variable:programm}'} и др.) подставятся по сделке чата при вставке шаблона.
            </p>
            <StepsEditor
              variables
              steps={editing.steps}
              disabled={busy}
              onChange={(steps) => setEditing({ ...editing, steps })}
            />
            <div className="form-actions">
              <button
                className="primary"
                type="submit"
                disabled={busy || !editing.name.trim() || editing.steps.every(isEmpty)}
              >
                {busy ? 'Сохранение…' : 'Сохранить шаблон'}
              </button>
              <button type="button" onClick={() => setEditing(null)}>
                Отмена
              </button>
            </div>
          </form>
        ) : (
          <>
            <div className="form-actions">
              <button className="primary" onClick={() => setEditing({ id: null, name: '', steps: [newStep()], shared: false })}>
                Создать шаблон
              </button>
            </div>
            {!templates.length && (
              <p className="muted">Шаблонов пока нет. Создайте цепочку сообщений, которую часто отправляете.</p>
            )}
            <ul className="settings-groups">
              {templates.map((t) => (
                <li key={t.id}>
                  <div>
                    <strong>{t.name}</strong> {t.shared && <span className="pill">общий</span>}
                    <p className="muted">
                      Сообщений: {t.steps.length} · Вложений: {t.steps.reduce((n, s) => n + s.files.length, 0)}
                    </p>
                  </div>
                  {t.canEdit ? (
                    <span className="form-actions">
                      <button onClick={() => setEditing({ id: t.id, name: t.name, steps: t.steps.map((s) => newStep(s.text, s.files)), shared: t.shared })}>
                        Изменить
                      </button>
                      <button className="danger" disabled={busy} onClick={() => void remove(t)}>
                        Удалить
                      </button>
                    </span>
                  ) : (
                    <span className="muted">меняют администраторы</span>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
    </>
  );
  if (embedded) return <div className="templates-embedded">{body}</div>;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet templates-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="templates-title"
        onClick={(e) => e.stopPropagation()}
      >
        {body}
      </div>
    </div>
  );
}
