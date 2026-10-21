import { useEffect, useState } from 'react';
import { DEAL_FIELD_ROLES, type DealFieldMapDto, type DealFieldRole } from '@btx24/shared';
import { apiGet, apiPut } from '../api.js';

const ROLES = Object.keys(DEAL_FIELD_ROLES) as DealFieldRole[];

/**
 * ⚙ → «Приложение»: системные поля сделки — что приложение заполняет при брони (ID брони, даты
 * брони и визита, гости, тип, комментарий) и по чему ищет прошлые брони клиента.
 */
export function DealFieldMapSettings() {
  const [saved, setSaved] = useState<DealFieldMapDto | null>(null);
  const [draft, setDraft] = useState<DealFieldMapDto>({});
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    apiGet<DealFieldMapDto>('/admin/booking-sync/deal-fields').then(
      (m) => {
        if (!active) return;
        setSaved(m);
        setDraft(m);
      },
      (e) => active && setError(e instanceof Error ? e.message : 'Не удалось загрузить'),
    );
    return () => {
      active = false;
    };
  }, []);

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      await f();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось');
    } finally {
      setBusy(false);
    }
  };
  const dirty = JSON.stringify(saved) !== JSON.stringify(draft);

  return (
    <section className="settings-card">
      <h3>Системные поля сделки</h3>
      <p className="muted">
        Поля, которые приложение заполняет при создании брони и по которым находит прошлые брони клиента. Коды полей свои
        у каждого портала — нажмите «Определить автоматически» (поиск по названиям) и проверьте.
      </p>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {note && <div className="notice">{note}</div>}
      {saved && (
        <>
          <div className="field-map">
            {ROLES.map((r) => (
              <label key={r}>
                <span>{DEAL_FIELD_ROLES[r]}</span>
                <input
                  value={draft[r] ?? ''}
                  placeholder="UF_CRM_…"
                  aria-label={`Код поля: ${DEAL_FIELD_ROLES[r]}`}
                  onChange={(e) => setDraft({ ...draft, [r]: e.target.value.trim().toUpperCase() })}
                />
              </label>
            ))}
          </div>
          <div className="form-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const found = await apiGet<DealFieldMapDto>('/admin/booking-sync/deal-fields/detect');
                  setDraft({ ...draft, ...found });
                  setNote(`Найдено полей: ${Object.keys(found).length} из ${ROLES.length}. Проверьте и сохраните.`);
                })
              }
            >
              Определить автоматически
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy || !dirty}
              onClick={() =>
                void run(async () => {
                  const m = await apiPut<DealFieldMapDto>('/admin/booking-sync/deal-fields', draft);
                  setSaved(m);
                  setDraft(m);
                  setNote('Сохранено');
                })
              }
            >
              Сохранить
            </button>
          </div>
        </>
      )}
    </section>
  );
}
