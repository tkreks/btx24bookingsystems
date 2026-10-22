import { useEffect, useState } from 'react';
import { CALL_STATUS_LABELS, todayIn, type CallLogDto, type CallLogRowDto, type CallScope, type CallStatus } from '@btx24/shared';
import { apiGet } from '../api.js';
import { openCrm } from '../b24.js';
import { fmtDayTitle, fmtTime, shiftDate } from '../format.js';

const OWNER: Record<number, { label: string; type: 'lead' | 'deal' | 'contact' | 'company' } | undefined> = {
  1: { label: 'Лид', type: 'lead' },
  2: { label: 'Сделка', type: 'deal' },
  3: { label: 'Контакт', type: 'contact' },
  4: { label: 'Компания', type: 'company' },
};
type Dir = 'all' | 'incoming' | 'outgoing';

const duration = (s: number) => (s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '—');

/** Журнал звонков дня: дата и время, кто звонил, куда, тип, статус (окно «Показать звонки»). */
export function CallLogModal({ scope, timezone, onClose }: { scope: CallScope; timezone: string; onClose: () => void }) {
  const [date, setDate] = useState(() => todayIn(timezone));
  const [data, setData] = useState<CallLogDto | null>(null);
  const [error, setError] = useState('');
  const [dir, setDir] = useState<Dir>('all');
  const [status, setStatus] = useState<'' | CallStatus>('');

  useEffect(() => {
    let active = true;
    apiGet<CallLogDto>(`/dashboard/call-log?date=${date}&scope=${scope}`).then(
      (d) => {
        if (!active) return;
        setData(d);
        setError('');
      },
      (e) => active && setError(e instanceof Error ? e.message : 'Не удалось загрузить звонки'),
    );
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    return () => {
      active = false;
      document.removeEventListener('keydown', esc);
    };
  }, [date, scope, onClose]);

  const shown = (data?.date === date ? data.items : []).filter((c) => (dir === 'all' || c.direction === dir) && (!status || c.status === status));
  const today = todayIn(timezone);
  const count = (f: (c: CallLogRowDto) => boolean) => (data?.date === date ? data.items.filter(f).length : 0);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet call-log" role="dialog" aria-modal="true" aria-label="Журнал звонков" onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>
            Журнал звонков{' '}
            <span className="muted">
              · {fmtDayTitle(date, timezone)}
              {data?.date === date && ` · ${data.items.length}`}
            </span>
          </h3>
          <button aria-label="Закрыть" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="call-log-bar">
          <div className="date-nav">
            <button aria-label="Предыдущий день" onClick={() => setDate(shiftDate(date, -1))}>
              ‹
            </button>
            <input type="date" aria-label="Дата" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} />
            <button aria-label="Следующий день" disabled={date >= today} onClick={() => setDate(shiftDate(date, 1))}>
              ›
            </button>
            {date !== today && <button onClick={() => setDate(today)}>Сегодня</button>}
          </div>
          <div className="segmented" role="group" aria-label="Тип звонка">
            {(
              [
                ['all', 'Все'],
                ['incoming', `Входящие ${count((c) => c.direction === 'incoming')}`],
                ['outgoing', `Исходящие ${count((c) => c.direction === 'outgoing')}`],
              ] as const
            ).map(([k, label]) => (
              <button key={k} aria-pressed={dir === k} className={dir === k ? 'active' : ''} onClick={() => setDir(k)}>
                {label}
              </button>
            ))}
          </div>
          <select aria-label="Статус" value={status} onChange={(e) => setStatus(e.target.value as '' | CallStatus)}>
            <option value="">Любой статус</option>
            {(Object.keys(CALL_STATUS_LABELS) as CallStatus[]).map((s) => (
              <option key={s} value={s}>
                {CALL_STATUS_LABELS[s]} ({count((c) => c.status === s)})
              </option>
            ))}
          </select>
        </div>
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        {data?.date !== date && !error && <p className="muted">Загрузка…</p>}
        {data?.date === date && !shown.length && <p className="muted">Звонков нет.</p>}
        {data?.truncated && <p className="notice">Звонков очень много — показаны не все.</p>}
        {shown.length > 0 && (
          <div className="call-log-table" role="table" aria-label="Звонки">
            <div className="call-log-row head" role="row">
              <span role="columnheader">Время</span>
              <span role="columnheader">Кто звонил</span>
              <span role="columnheader">Куда звонил</span>
              <span role="columnheader">Тип</span>
              <span role="columnheader">Статус</span>
              <span role="columnheader">Длит.</span>
              <span role="columnheader">CRM</span>
            </div>
            {shown.map((c) => {
              const client = (
                <span className="call-party">
                  <span className="call-phone">{c.clientPhone ?? 'номер скрыт'}</span>
                  {c.contact && (
                    <button className="link" onClick={() => openCrm('contact', c.contact!.id)}>
                      {c.contact.name ?? `Контакт #${c.contact.id}`}
                    </button>
                  )}
                </span>
              );
              const employee = <span className="call-party">{c.employee ? (c.employee.name ?? `Сотрудник #${c.employee.id}`) : '—'}</span>;
              const o = OWNER[c.owner.typeId];
              return (
                <div key={c.activityId} className={`call-log-row ${c.status}`} role="row">
                  <span role="cell" className="call-time" data-label="Время">
                    {fmtTime(c.at, timezone)}
                  </span>
                  <span role="cell" data-label="Кто звонил">
                    {c.direction === 'incoming' ? client : employee}
                  </span>
                  <span role="cell" data-label="Куда звонил">
                    {c.direction === 'incoming' ? employee : client}
                  </span>
                  <span role="cell" data-label="Тип">
                    {c.direction === 'incoming' ? '↙ Входящий' : '↗ Исходящий'}
                  </span>
                  <span role="cell" data-label="Статус">
                    <span className={`pill call-status ${c.status}`}>{CALL_STATUS_LABELS[c.status]}</span>
                  </span>
                  <span role="cell" data-label="Длительность" className="call-duration">
                    {duration(c.durationSec)}
                  </span>
                  <span role="cell" data-label="CRM">
                    {o ? (
                      <button className="link" onClick={() => openCrm(o.type, c.owner.id)}>
                        {c.owner.title ?? `${o.label} #${c.owner.id}`}
                      </button>
                    ) : (
                      <span className="muted">#{c.owner.id}</span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        )}
        <p className="muted dash-note">
          «Куда звонил» для входящих — сотрудник, принявший звонок: номер линии компании станет виден после выдачи приложению права
          «Телефония». Исходящий без разговора — «нет ответа».
        </p>
      </div>
    </div>
  );
}
