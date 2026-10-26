import { useState } from 'react';
import { DEFAULT_CLIENT_MESSAGE, hasPaymentLinkToken, type MessageTemplateDto, type MessageTemplatePurpose, type SaveTemplateDto } from '@btx24/shared';
import { apiDelete, apiPost, apiPut } from '../api.js';
import { isEmpty, newStep, toSteps, type ChainStep } from './chain.js';
import { StepsEditor } from './StepsEditor.js';
import { MinimizeButton } from '../Minimize.js';

type Editing = { id: string | null; name: string; steps: ChainStep[]; shared: boolean; purpose: MessageTemplatePurpose };

/**
 * Шаблоны сообщений: свои и общие (общие меняют администраторы приложения). Окно в чате или
 * встроенный блок страницы «Шаблоны» (`embedded`). Шаблоны оплаты (системные, выбираются в группе
 * для ссылки на предоплату/доплату) создают и видят здесь только администраторы.
 */
export function TemplatesManager({
  templates,
  onChanged,
  onClose,
  initial,
  admin = false,
  embedded = false,
  open,
  onSaved,
  onDone,
}: {
  /** Открыть сразу этот шаблон (id) или новый с текстом (id null) — из списка «Системные». */
  open?: { id: string | null; name: string; steps: ChainStep[]; purpose: MessageTemplatePurpose };
  /** Шаблон сохранён (до закрытия редактора) — например, назначить его группе. */
  onSaved?: (t: MessageTemplateDto) => Promise<void> | void;
  /** Редактор, открытый через `open`, закрыт (сохранили или отменили). */
  onDone?: () => void;
  templates: MessageTemplateDto[];
  onChanged: (templates: MessageTemplateDto[]) => void;
  onClose: () => void;
  /** Открыть сразу на создании шаблона из текущей цепочки. */
  initial?: ChainStep[];
  /** Администратор приложения — может создавать и менять общие шаблоны. */
  admin?: boolean;
  embedded?: boolean;
}) {
  const [editing, setEditingState] = useState<Editing | null>(open ? { ...open, shared: open.purpose !== 'chat' } : initial ? { id: null, name: '', steps: initial, shared: false, purpose: 'chat' } : null);
  const setEditing = (e: Editing | null) => {
    setEditingState(e);
    if (!e && open) onDone?.();
  };
  // В чате шаблоны оплаты не нужны (ссылку подставляет автоматизация); на странице «Шаблоны» — администраторам.
  const shown = templates.filter((t) => t.purpose === 'chat' || (admin && embedded));
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    if (!editing || uploading) return;
    const body: SaveTemplateDto = {
      name: editing.name,
      steps: toSteps(editing.steps),
      ...(admin ? { shared: editing.purpose !== 'chat' || editing.shared, purpose: editing.purpose } : {}),
    };
    setBusy(true);
    setError('');
    try {
      const saved = editing.id
        ? await apiPut<MessageTemplateDto>(`/openlines/templates/${editing.id}`, body)
        : await apiPost<MessageTemplateDto>('/openlines/templates', body);
      onChanged(
        [...templates.filter((t) => t.id !== saved.id), saved].sort((a, b) => Number(b.shared) - Number(a.shared) || a.name.localeCompare(b.name, 'ru')),
      );
      await onSaved?.(saved);
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
          <MinimizeButton label="Шаблоны" />
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
            {admin && embedded && (
              <label>
                Назначение
                <select
                  value={editing.purpose}
                  onChange={(e) => {
                    const purpose = e.target.value as MessageTemplatePurpose;
                    const blank = editing.steps.every(isEmpty);
                    setEditing({ ...editing, purpose, shared: purpose !== 'chat' || editing.shared, steps: purpose === 'payment' && blank ? [newStep(DEFAULT_CLIENT_MESSAGE)] : editing.steps });
                  }}
                >
                  <option value="chat">Шаблон для чатов</option>
                  <option value="payment">Сообщение об оплате (системный — выбирается в настройках группы)</option>
                  <option value="auto">Автоматическая рассылка (системный — выбирается в правилах рассылки группы)</option>
                </select>
              </label>
            )}
            {admin && editing.purpose === 'chat' && (
              <label className="check">
                <input type="checkbox" checked={editing.shared} onChange={(e) => setEditing({ ...editing, shared: e.target.checked })} />
                Общий шаблон — видят все сотрудники
              </label>
            )}
            <p className="muted">К каждому сообщению можно добавить файлы из устройства или Диска Битрикс24.</p>
            {editing.purpose === 'payment' ? (
              <p className="muted">
                Уйдёт клиенту автоматически, когда портал выдаст ссылку на оплату. {'{link}'} или {'{=Variable:paymentlink_new}'} — ссылка (обязательно), {'{prepayment}'} или {'{=Variable:paymentsum_new}'} — сумма к оплате,{' '}
                {'{minutes}'} — минут на оплату, {'{deadline}'} — оплатить до; остальные переменные — по сделке. Сообщения — по порядку, файлы — после текста.
              </p>
            ) : editing.purpose === 'auto' ? (
              <p className="muted">
                Уйдёт клиенту автоматически по правилу рассылки группы (например, за сутки до начала брони, в рабочее время). Переменные
                ({'{{Дата начала визита}}'}, {'{{Контакт: Имя}}'} и др.) — по сделке брони. Сообщения — по порядку, файлы — после текста.
              </p>
            ) : (
              <p className="muted">
                Сообщения уйдут по порядку, файлы — отдельными сообщениями после текста. Переменные ({'{{Дата начала визита}}'}, {'{{Контакт: Имя}}'},{' '}
                {'{=Variable:programm}'} и др.) подставятся по сделке чата при вставке шаблона.
              </p>
            )}
            {editing.purpose === 'payment' && !editing.steps.some((st) => hasPaymentLinkToken(st.text)) && (
              <p className="notice error">В шаблоне нет ссылки на оплату ({'{link}'} или {'{=Variable:paymentlink_new}'}) — клиент её не получит.</p>
            )}
            <StepsEditor
              variables
              onUploadingChange={setUploading}
              paymentVariables={editing.purpose === 'payment'}
              steps={editing.steps}
              disabled={busy}
              onChange={(steps) => setEditing({ ...editing, steps })}
            />
            <div className="form-actions">
              <button
                className="primary"
                type="submit"
                disabled={busy || uploading || !editing.name.trim() || editing.steps.every(isEmpty)}
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
              <button className="primary" onClick={() => setEditing({ id: null, name: '', steps: [newStep()], shared: false, purpose: 'chat' })}>
                Создать шаблон
              </button>
            </div>
            {!shown.length && (
              <p className="muted">Шаблонов пока нет. Создайте цепочку сообщений, которую часто отправляете.</p>
            )}
            <ul className="settings-groups">
              {shown.map((t) => (
                <li key={t.id}>
                  <div>
                    <strong>{t.name}</strong> {t.purpose === 'payment' ? (
                      <span className="pill paid">оплата · системный</span>
                    ) : t.purpose === 'auto' ? (
                      <span className="pill paid">рассылка · системный</span>
                    ) : (
                      t.shared && <span className="pill">общий</span>
                    )}
                    <p className="muted">
                      Сообщений: {t.steps.length} · Вложений: {t.steps.reduce((n, s) => n + s.files.length, 0)}
                    </p>
                  </div>
                  {t.canEdit ? (
                    <span className="form-actions">
                      <button onClick={() => setEditing({ id: t.id, name: t.name, steps: t.steps.map((s) => newStep(s.text, s.files)), shared: t.shared, purpose: t.purpose })}>
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
