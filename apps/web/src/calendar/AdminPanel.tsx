import { useEffect, useState } from 'react';
import { apiGet, apiPost, ApiRequestError } from '../api.js';

interface PlacementStatus {
  placement: string;
  title: string;
  bound: boolean;
}
interface PlacementsState {
  placements: PlacementStatus[];
  events: { event: string; bound: boolean }[];
}

const LABELS: Record<string, string> = {
  CRM_DEAL_DETAIL_TAB: 'Вкладка в карточке сделки',
  CRM_DEAL_DETAIL_TOOLBAR: 'Кнопка в карточке сделки',
  LEFT_MENU: 'Пункт левого меню',
  CALL_CARD: 'Вкладка в окне звонка (карточка клиента)',
};
const EVENT_LABELS: Record<string, string> = {
  ONVOXIMPLANTCALLINIT: 'Событие: начало звонка',
  ONVOXIMPLANTCALLSTART: 'Событие: ответ на звонок',
  ONVOXIMPLANTCALLEND: 'Событие: конец звонка',
  ONBOOKINGADD: 'Событие: бронь создана в Битрикс24',
  ONBOOKINGUPDATE: 'Событие: бронь изменена в Битрикс24',
  ONBOOKINGDELETE: 'Событие: бронь удалена в Битрикс24',
  ONCRMDEALADD: 'Событие: сделка создана',
  ONCRMDEALUPDATE: 'Событие: сделка изменена',
  ONCRMDEALDELETE: 'Событие: сделка удалена',
};

/** Встройки: показываются только администратору, регистрируются только по его явному действию. */
export function PlacementSettings() {
  const [items, setItems] = useState<PlacementsState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<PlacementsState>('/admin/placements').then(setItems, (e) =>
      setError(e instanceof ApiRequestError ? e.message : 'Ошибка'),
    );
  }, []);

  const sync = async (rebind = false) => {
    if (
      !confirm(
        rebind
          ? 'Перевстроить? Встройки и подписки на звонки приложения будут сняты и поставлены заново (после — обновить страницу Битрикс24).'
          : 'Добавить встройки приложения на портал? Вкладки появятся в карточке сделки и окне звонка у всех пользователей.',
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      setItems(await apiPost<PlacementsState>(rebind ? '/admin/placements/rebind' : '/admin/placements/sync'));
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'Ошибка');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h3>Встройки приложения</h3>
      {error && <div className="notice error">{error}</div>}
      {!items && !error && <p className="muted">Загрузка…</p>}
      {items && (
        <>
          <ul className="placements">
            {items.placements.map((p) => (
              <li key={p.placement}>
                <span>{LABELS[p.placement] ?? p.placement}</span>
                <span className={p.bound ? 'ok' : 'muted'}>{p.bound ? 'подключена' : 'не подключена'}</span>
              </li>
            ))}
            {items.events.map((e) => (
              <li key={e.event}>
                <span>{EVENT_LABELS[e.event] ?? e.event}</span>
                <span className={e.bound ? 'ok' : 'muted'}>{e.bound ? 'подключено' : 'не подключено'}</span>
              </li>
            ))}
          </ul>
          <p className="muted">
            Вкладка в окне звонка и события звонков нужны для карточки клиента при звонке (право «Телефония»). События броней и
            сделок — чтобы приложение сразу узнавало об изменениях в Битрикс24 (сверка раз в 10 минут остаётся). После подключения
            сотрудникам нужно один раз обновить страницу Битрикс24.
          </p>
          <div className="form-actions">
            {(items.placements.some((p) => !p.bound) || items.events.some((e) => !e.bound)) && (
              <button className="primary" disabled={busy} onClick={() => void sync()}>
                {busy ? 'Подключаем…' : 'Подключить встройки'}
              </button>
            )}
            <button disabled={busy} onClick={() => void sync(true)} title="Снять и поставить заново все встройки и подписки приложения">
              Перевстроить
            </button>
          </div>
        </>
      )}
    </section>
  );
}
