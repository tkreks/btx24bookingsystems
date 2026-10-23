import { useEffect, useState } from 'react';
import { CALL_STATUS_LABELS, type CallLogRowDto, type CallScope, type RecentCallsDto } from '@btx24/shared';
import { apiGet } from '../api.js';
import { openCrm } from '../b24.js';
import { fmtAt, fmtDuration } from '../format.js';
import { Avatar } from './Avatar.js';
import { Icon } from './icons.js';
import { ListMore } from './ListMore.js';
import { DealStatusBadge } from './DealStatusBadge.js';

const OWNER: Record<number, 'lead' | 'deal' | 'contact' | 'company' | undefined> = { 1: 'lead', 2: 'deal', 3: 'contact', 4: 'company' };
/** Сколько звонков показывать сразу и сколько добавляет «Показать ещё». */
const STEP = 5;

/** Цвет строки: входящий — зелёный, исходящий — голубой, исходящий без ответа — жёлтый, пропущенный — красный. */
export function callTone(c: Pick<CallLogRowDto, 'direction' | 'status'>): 'in' | 'out' | 'noanswer' | 'missed' {
  if (c.status === 'missed') return 'missed';
  if (c.status === 'no_answer') return 'noanswer';
  return c.direction === 'incoming' ? 'in' : 'out';
}

/**
 * Блок «Звонки» на дашборде: последние звонки периода дашборда из журнала звонков (дела CRM), к
 * которым у сотрудника есть доступ, — по 5, «Показать ещё». Цвет — по направлению и статусу,
 * длительность разговора; за один день — только время, за период — с датой. Клик — карточка
 * сделки, лида или контакта.
 */
export function RecentCalls({ scope, timezone, from, to }: { scope: CallScope; timezone: string; from: string; to: string }) {
  const [data, setData] = useState<{ key: string; dto: RecentCallsDto } | null>(null);
  const [error, setError] = useState('');
  const key = `${scope}|${from}|${to}`;
  // «Показать ещё» — в пределах выбранных «Все / Мои» и периода; смена — снова 5.
  const [more, setMore] = useState({ key, n: STEP });
  const shown = more.key === key ? more.n : STEP;

  useEffect(() => {
    let active = true;
    apiGet<RecentCallsDto>(`/dashboard/recent-calls?scope=${scope}&from=${from}&to=${to}`).then(
      (dto) => {
        if (!active) return;
        setData({ key: `${scope}|${from}|${to}`, dto });
        setError('');
      },
      (e) => active && setError(e instanceof Error ? e.message : 'Не удалось загрузить звонки'),
    );
    return () => {
      active = false;
    };
  }, [scope, from, to]);

  const items = data?.key === key ? data.dto.items : null;
  return (
    <section className="day-panel dash-block dash-recent-calls">
      <DashBadge name="phone" />
      <p className="dash-attention-title muted">Звонки</p>
      {error && <p className="muted">{error}</p>}
      {!items && !error && <p className="muted">Загрузка…</p>}
      {items && !items.length && <p className="muted">Звонков за период нет.</p>}
      <ul className="dt-rows">
        {items?.slice(0, shown).map((c) => {
          const type = OWNER[c.owner.typeId];
          const who = c.contact?.name || c.owner.title || c.clientPhone || 'номер скрыт';
          const employee = c.employee ? (c.employee.name ?? `Сотрудник #${c.employee.id}`) : null;
          const tone = callTone(c);
          return (
            <li key={c.activityId}>
              <button className={`dt-row call-tone-${tone}`} disabled={!type} onClick={() => type && openCrm(type, c.owner.id)}>
                <span className="dt-main">
                  <b>
                    <span className="call-dir" aria-label={c.direction === 'incoming' ? 'Входящий' : 'Исходящий'}>
                      {c.direction === 'incoming' ? '↙' : '↗'}
                    </span>{' '}
                    {who}
                  </b>
                  {c.dealStatus && (
                    <span className="dt-title">
                      <DealStatusBadge s={c.dealStatus} />
                    </span>
                  )}
                  <span className="muted dt-who">
                    {c.clientPhone && who !== c.clientPhone ? `${c.clientPhone}` : ''}
                    {c.clientPhone && who !== c.clientPhone && employee ? ' · ' : ''}
                    {employee && c.employee && (
                      <>
                        <Avatar src={c.employee.photo} name={employee} size={16} /> {employee}
                      </>
                    )}
                  </span>
                </span>
                <span className="dt-side">
                  <span>{fmtAt(c.at, timezone, from === to)}</span>
                  <span className={`pill call-status ${c.status}`}>
                    {CALL_STATUS_LABELS[c.status]}
                    {c.durationSec > 0 ? ` · ${fmtDuration(c.durationSec)}` : ''}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {items && <ListMore total={items.length} shown={shown} step={STEP} onShow={(n) => setMore({ key, n })} />}
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
