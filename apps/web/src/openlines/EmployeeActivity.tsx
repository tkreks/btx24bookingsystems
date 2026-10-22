import { Fragment, useEffect, useState } from 'react';
import { ACTIVITY_KINDS, ACTIVITY_KIND_LABELS, todayIn, type ActivityDayDto, type ActivityKind, type EmployeeActivityDto } from '@btx24/shared';
import { apiGet } from '../api.js';
import { openCrm } from '../b24.js';
import { fmtDayTitle, fmtTime, shiftDate } from '../format.js';

const ICON: Record<ActivityKind, string> = { call: '📞', chat: '💬', phone: '📱', deal: '🤝', booking: '📅', app: '🖥' };
const sum = (h: Record<ActivityKind, number>) => ACTIVITY_KINDS.reduce((s, k) => s + h[k], 0);

/**
 * «Активность сотрудников» (только администраторам приложения): кто что делал по часам 9–22 —
 * звонки, сообщения (свои и с телефона на смене), сделки, брони, действия в приложении. Смена —
 * по учёту рабочего времени Битрикс24. Клик по сотруднику — лента его действий за день.
 */
export function EmployeeActivity({ timezone }: { timezone: string }) {
  const [date, setDate] = useState(() => todayIn(timezone));
  const [res, setRes] = useState<{ date: string; data: ActivityDayDto | null; error: string } | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    apiGet<ActivityDayDto>(`/dashboard/activity?date=${date}`).then(
      (data) => active && setRes({ date, data, error: '' }),
      (e) => active && setRes({ date, data: null, error: e instanceof Error ? e.message : 'Не удалось загрузить активность' }),
    );
    return () => {
      active = false;
    };
  }, [date]);
  const cur = res?.date === date ? res : null;
  const d = cur?.data;
  const max = Math.max(1, ...(d?.employees ?? []).flatMap((e) => e.hours.map(sum)));
  const hours = d ? Array.from({ length: d.toHour - d.fromHour }, (_, i) => d.fromHour + i) : [];

  return (
    <section className="day-panel dash-activity" aria-label="Активность сотрудников">
      <div className="act-head">
        <p className="dash-attention-title muted">Активность сотрудников</p>
        <span className="act-date">
          <button type="button" aria-label="Предыдущий день" onClick={() => setDate(shiftDate(date, -1))}>
            ‹
          </button>
          <input type="date" aria-label="День" value={date} max={todayIn(timezone)} onChange={(e) => e.target.value && setDate(e.target.value)} />
          <button type="button" aria-label="Следующий день" disabled={date >= todayIn(timezone)} onClick={() => setDate(shiftDate(date, 1))}>
            ›
          </button>
        </span>
      </div>
      <p className="act-legend muted">
        {fmtDayTitle(date, timezone)} ·{' '}
        {ACTIVITY_KINDS.map((k) => (
          <span key={k}>
            {ICON[k]} {ACTIVITY_KIND_LABELS[k].toLowerCase()}
          </span>
        ))}
      </p>
      {!cur && <p className="muted">Загрузка…</p>}
      {cur?.error && <p className="notice error">{cur.error}</p>}
      {d && !d.employees.length && <p className="muted">В группах нет сотрудников.</p>}
      {d && d.employees.length > 0 && (
        <div className="act-scroll">
          <table className="act-table">
            <thead>
              <tr>
                <th className="act-who">Сотрудник</th>
                {hours.map((h) => (
                  <th key={h}>{String(h).padStart(2, '0')}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.employees.map((e) => (
                <Fragment key={e.userId}>
                  <tr className={open === e.userId ? 'open' : ''}>
                    <th className="act-who">
                      <button type="button" aria-expanded={open === e.userId} onClick={() => setOpen(open === e.userId ? null : e.userId)}>
                        <b>{e.name}</b>
                        <span className={`act-shift${e.shift ? ' on' : ''}`}>
                          {e.shift ? `смена ${fmtTime(e.shift.start, timezone)}–${e.shift.end ? fmtTime(e.shift.end, timezone) : 'сейчас'}` : 'смены нет'}
                        </span>
                        <span className="act-totals muted">{totalsText(e)}</span>
                      </button>
                    </th>
                    {e.hours.map((h, i) => {
                      const n = sum(h);
                      return (
                        <td key={i} title={cellTitle(hours[i], h)} style={n ? { background: `rgba(50, 105, 246, ${0.12 + (0.7 * n) / max})`, color: n / max > 0.55 ? '#fff' : undefined } : undefined}>
                          {n || ''}
                        </td>
                      );
                    })}
                  </tr>
                  {open === e.userId && (
                    <tr className="act-events-row">
                      <td colSpan={hours.length + 1}>
                        {!e.events.length && <p className="muted">Действий за день нет.</p>}
                        <ul className="act-events">
                          {e.events.map((ev, i) => (
                            <li key={i}>
                              <time>{fmtTime(ev.at, timezone)}</time>
                              <span aria-label={ACTIVITY_KIND_LABELS[ev.kind]}>{ICON[ev.kind]}</span>
                              {ev.dealId ? (
                                <button type="button" className="link" onClick={() => openCrm('deal', ev.dealId!)}>
                                  {ev.text}
                                </button>
                              ) : (
                                <span>{ev.text}</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {d?.notes.map((n) => (
        <p key={n} className="muted act-note">
          {n}
        </p>
      ))}
      <p className="muted act-note">
        Сообщения с телефона (Wazzup «Исходящее сообщение») — тому, чья смена; боты, системные сообщения и автосообщения приложения не
        учитываются. Минуты в чатах — оценка: сообщения с перерывом до 10 минут считаются одной сессией.
      </p>
    </section>
  );
}

function totalsText(e: EmployeeActivityDto): string {
  const t = e.totals;
  return [
    t.call ? `📞 ${t.call} · ${e.callMinutes} мин` : '',
    t.chat + t.phone ? `💬 ${t.chat + t.phone}${t.phone ? ` (📱 ${t.phone})` : ''} · ~${e.chatMinutes} мин` : '',
    t.deal ? `🤝 ${t.deal}` : '',
    t.booking ? `📅 ${t.booking}` : '',
    t.app ? `🖥 ${t.app}` : '',
  ]
    .filter(Boolean)
    .join('  ');
}

function cellTitle(hour: number, h: Record<ActivityKind, number>): string {
  const parts = ACTIVITY_KINDS.filter((k) => h[k]).map((k) => `${ACTIVITY_KIND_LABELS[k]}: ${h[k]}`);
  return `${String(hour).padStart(2, '0')}:00–${String(hour + 1).padStart(2, '0')}:00${parts.length ? `\n${parts.join('\n')}` : ' — нет действий'}`;
}
