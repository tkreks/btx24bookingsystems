import { useEffect, useState } from 'react';
import { CALL_STATUS_LABELS, type CallScope, type RecentCallsDto } from '@btx24/shared';
import { apiGet } from '../api.js';
import { openCrm } from '../b24.js';
import { fmtDateTime } from '../format.js';
import { Icon } from './icons.js';

const OWNER: Record<number, 'lead' | 'deal' | 'contact' | 'company' | undefined> = { 1: 'lead', 2: 'deal', 3: 'contact', 4: 'company' };
/** Сколько звонков показывать сразу и сколько добавляет «Показать ещё». */
const STEP = 5;

/**
 * Блок «Звонки» на дашборде: последние звонки из журнала звонков (дела CRM), к которым у
 * сотрудника есть доступ, — по 5, «Показать ещё 5». Клик — карточка сделки, лида или контакта.
 */
export function RecentCalls({ scope, timezone }: { scope: CallScope; timezone: string }) {
  const [data, setData] = useState<RecentCallsDto | null>(null);
  const [error, setError] = useState('');
  // «Показать ещё» — в пределах выбранного «Все / Мои»; смена — снова 5.
  const [more, setMore] = useState({ scope, n: STEP });
  const shown = more.scope === scope ? more.n : STEP;

  useEffect(() => {
    let active = true;
    apiGet<RecentCallsDto>(`/dashboard/recent-calls?scope=${scope}`).then(
      (d) => {
        if (!active) return;
        setData(d);
        setError('');
      },
      (e) => active && setError(e instanceof Error ? e.message : 'Не удалось загрузить звонки'),
    );
    return () => {
      active = false;
    };
  }, [scope]);

  const items = data?.scope === scope ? data.items : null;
  return (
    <section className="day-panel dash-block dash-recent-calls">
      <DashBadge name="phone" />
      <p className="dash-attention-title muted">Звонки</p>
      {error && <p className="muted">{error}</p>}
      {!items && !error && <p className="muted">Загрузка…</p>}
      {items && !items.length && <p className="muted">Звонков пока нет.</p>}
      <ul className="dt-rows">
        {items?.slice(0, shown).map((c) => {
          const type = OWNER[c.owner.typeId];
          const who = c.contact?.name || c.owner.title || c.clientPhone || 'номер скрыт';
          const employee = c.employee ? (c.employee.name ?? `Сотрудник #${c.employee.id}`) : null;
          return (
            <li key={c.activityId}>
              <button className={`dt-row call-${c.status}`} disabled={!type} onClick={() => type && openCrm(type, c.owner.id)}>
                <span className="dt-main">
                  <b>
                    <span className="call-dir" aria-label={c.direction === 'incoming' ? 'Входящий' : 'Исходящий'}>
                      {c.direction === 'incoming' ? '↙' : '↗'}
                    </span>{' '}
                    {who}
                  </b>
                  <span className="muted">
                    {c.clientPhone && who !== c.clientPhone ? `${c.clientPhone}` : ''}
                    {c.clientPhone && who !== c.clientPhone && employee ? ' · ' : ''}
                    {employee ?? ''}
                  </span>
                </span>
                <span className="dt-side">
                  <span>{fmtDateTime(c.at, timezone)}</span>
                  <span className={`pill call-status ${c.status}`}>{CALL_STATUS_LABELS[c.status]}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {items && items.length > shown && (
        <button className="dash-more" onClick={() => setMore({ scope, n: shown + STEP })}>
          Показать ещё {Math.min(STEP, items.length - shown)}
        </button>
      )}
    </section>
  );
}

/** Иконка блока дашборда — в углу блока, а не у текста. */
export function DashBadge({ name }: { name: Parameters<typeof Icon>[0]['name'] }) {
  return (
    <span className="dash-badge" aria-hidden="true">
      <Icon name={name} size={20} />
    </span>
  );
}
