import { useState } from 'react';
import type { MessengerDto, MessengerLinkDto } from '@btx24/shared';
import { apiPut } from '../api.js';

/**
 * «Сопоставить» (ADR 0014, решение владельца 2026-10-24): номер привязывается к **своей новой**
 * открытой линии приложения — к существующим линиям (WAZZUP и др.) не привязываем. После привязки
 * сотрудники пишут клиенту через линию Битрикс24 (действия видны там, права на чаты — линии), а
 * приложение доставляет сообщения через номер. Без привязки номер работает только в приложении.
 */
export function MessengerLinkDialog({ messenger, onClose, onSaved }: { messenger: MessengerDto; onClose: () => void; onSaved: (m: MessengerDto) => void }) {
  const [name, setName] = useState(`${messenger.kind === 'telegram' ? 'Telegram' : 'WhatsApp'} +${messenger.phone}`);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async (body: MessengerLinkDto) => {
    setSaving(true);
    setError('');
    try {
      onSaved(await apiPut<MessengerDto>(`/admin/messengers/${messenger.id}/line`, body));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось сохранить');
      setSaving(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet messenger-wizard" role="dialog" aria-modal="true" aria-labelledby="ml-title" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2 id="ml-title">Открытая линия для +{messenger.phone}</h2>
          <button type="button" aria-label="Закрыть" onClick={onClose}>
            ×
          </button>
        </header>
        {messenger.line ? (
          <>
            <p>
              Номер подключён к своей открытой линии «{messenger.line.name ?? `#${messenger.line.lineId}`}». Сотрудники пишут клиентам через неё
              — в Битрикс24 или в разделе «Чаты» приложения; права на чаты — как у линии.
            </p>
            <p className="muted">Отвязать: номер будет работать только в приложении (для групп номера). Линия в Битрикс24 останется, коннектор отключится.</p>
          </>
        ) : (
          <>
            <p>
              Приложение создаст в Битрикс24 новую открытую линию и станет для неё сервером сообщений: клиент пишет на этот номер — сообщение
              появляется в линии; оператор отвечает в линии — сообщение уходит клиенту через номер. Правки и удаления — в обе стороны.
            </p>
            <label className="settings-form">
              Название линии
              <input value={name} maxLength={255} onChange={(e) => setName(e.target.value)} disabled={saving} />
            </label>
            <p className="muted">Распределение чатов по операторам и права на них настраиваются у линии в Битрикс24 (Контакт-центр).</p>
          </>
        )}
        {error && <div className="notice error" role="alert">{error}</div>}
        <div className="form-actions">
          {messenger.line ? (
            <button type="button" className="danger" disabled={saving} onClick={() => void save({ mode: null })}>
              {saving ? 'Отвязываем…' : 'Отвязать от линии'}
            </button>
          ) : (
            <button type="button" className="primary" disabled={saving || !name.trim()} onClick={() => void save({ mode: 'own', name: name.trim() })}>
              {saving ? 'Создаём линию…' : 'Создать линию и привязать'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
