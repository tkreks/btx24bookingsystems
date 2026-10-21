import { useEffect, useState } from 'react';
import type { ResourceAdminDto } from '@btx24/shared';
import { apiGet, apiPut } from '../api.js';

/**
 * ⚙ → «Ресурсы»: имя ресурса для клиента. Если задано — в сообщениях клиенту ({house}) идёт оно,
 * иначе — название ресурса из Битрикс24. Хранится в приложении.
 */
export function ResourceNames() {
  const [rows, setRows] = useState<ResourceAdminDto[] | null>(null);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState<number | null>(null);
  const [saved, setSaved] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    apiGet<ResourceAdminDto[]>('/admin/resources').then(
      (r) => active && setRows(r),
      (e) => active && setError(e instanceof Error ? e.message : 'Не удалось загрузить ресурсы'),
    );
    return () => {
      active = false;
    };
  }, []);

  const save = async (r: ResourceAdminDto) => {
    const value = (drafts[r.resourceId] ?? r.clientName ?? '').trim();
    if (value === (r.clientName ?? '')) return;
    setSaving(r.resourceId);
    setError('');
    try {
      const updated = await apiPut<ResourceAdminDto>(`/admin/resources/${r.resourceId}`, { clientName: value || null });
      setRows((prev) => prev?.map((x) => (x.resourceId === r.resourceId ? updated : x)) ?? null);
      setSaved(r.resourceId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось сохранить');
    } finally {
      setSaving(null);
    }
  };

  return (
    <section className="settings-card resource-names">
      <h3>Имена ресурсов для клиента</h3>
      <p className="muted">
        В календаре — как в Битрикс24 («Баня 3»). В сообщениях клиенту переменная {'{house}'} берёт имя отсюда («Дом
        знахаря»), а если оно пустое — название ресурса. Сохраняется при выходе из поля.
      </p>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {!rows && !error && <p className="muted">Загрузка…</p>}
      {rows && !rows.length && <p className="muted">Ресурсы появятся после первой сверки с Битрикс24 (до 10 минут).</p>}
      <div className="resource-name-list">
        {rows?.map((r) => (
          <label key={r.resourceId} className={r.archived ? 'archived' : ''}>
            <span>
              {r.name}
              {r.archived && <span className="muted"> · удалён в Битрикс24</span>}
            </span>
            <input
              value={drafts[r.resourceId] ?? r.clientName ?? ''}
              placeholder={r.name}
              maxLength={255}
              disabled={saving === r.resourceId}
              aria-label={`Имя для клиента: ${r.name}`}
              onChange={(e) => {
                setDrafts({ ...drafts, [r.resourceId]: e.target.value });
                setSaved(null);
              }}
              onBlur={() => void save(r)}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
            {saved === r.resourceId && <span className="muted">сохранено</span>}
          </label>
        ))}
      </div>
    </section>
  );
}
