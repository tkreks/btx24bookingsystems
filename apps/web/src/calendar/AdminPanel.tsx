import { useEffect, useState } from 'react';
import { apiGet, apiPost, ApiRequestError } from '../api.js';

interface PlacementStatus {
  placement: string;
  title: string;
  bound: boolean;
}

const LABELS: Record<string, string> = {
  CRM_DEAL_DETAIL_TAB: 'Вкладка в карточке сделки',
  CRM_DEAL_DETAIL_TOOLBAR: 'Кнопка в карточке сделки',
  LEFT_MENU: 'Пункт левого меню',
};

/** Встройки: показываются только администратору, регистрируются только по его явному действию. */
export function AdminPanel({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<PlacementStatus[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<PlacementStatus[]>('/admin/placements').then(setItems, (e) => setError(e instanceof ApiRequestError ? e.message : 'Ошибка'));
  }, []);

  const sync = async () => {
    if (!confirm('Добавить встройки приложения на портал? Вкладка и кнопка появятся в карточке сделки у всех пользователей.')) return;
    setBusy(true);
    setError(null);
    try {
      setItems(await apiPost<PlacementStatus[]>('/admin/placements/sync'));
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'Ошибка');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Встройки приложения</h2>
          <button aria-label="Закрыть" onClick={onClose}>×</button>
        </header>
        {error && <div className="notice error">{error}</div>}
        {!items && !error && <p className="muted">Загрузка…</p>}
        {items && (
          <>
            <ul className="placements">
              {items.map((p) => (
                <li key={p.placement}>
                  <span>{LABELS[p.placement] ?? p.placement}</span>
                  <span className={p.bound ? 'ok' : 'muted'}>{p.bound ? 'подключена' : 'не подключена'}</span>
                </li>
              ))}
            </ul>
            {items.some((p) => !p.bound) && (
              <button className="primary" disabled={busy} onClick={sync}>{busy ? 'Подключаем…' : 'Подключить встройки'}</button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
