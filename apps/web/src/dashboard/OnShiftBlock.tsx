import { BlockLoading } from './BlockLoading.js';
import { useDashboardQuery } from './DashboardSync.js';
import type { OnShiftDto, WorkdayDto } from '@btx24/shared';
import { fmtWhen } from '../format.js';
import { Avatar } from '../openlines/Avatar.js';
import { DashBadge } from '../openlines/RecentCalls.js';

export function OnShiftBlock({timezone}:{timezone:string}) {
  const roster=useDashboardQuery<OnShiftDto>('/workday/on-shift');
  const workday=useDashboardQuery<WorkdayDto>('/workday');
  const people=roster.data; const day=workday.data;
  // Свой рабочий день — кнопки в шапке дашборда (WorkdayControls); здесь — только кто на смене.
  const error=roster.error||workday.error;
  return <section className="day-panel dash-block on-shift-block">
    <DashBadge name="people"/><p className="dash-attention-title muted">Кто на смене?{people&&<span className="pill">{people.employees.length}</span>}</p>
    {error&&<p className="notice error" role="alert">{error}</p>}
    {!people&&!error&&<BlockLoading />}
    {people&&!people.employees.length&&<p className="muted">Сейчас никто не на смене.</p>}
    <ul className="on-shift-list">{people?.employees.map(p=><li key={p.userId}>
      <Avatar src={p.photo} name={p.name} size={28}/><span className="on-shift-person"><b>{p.name}</b><span className="muted">В приложении: {p.lastActivityAt?fmtWhen(p.lastActivityAt,timezone):'ещё нет'}</span></span>
      <span className={`pill ${p.status==='PAUSED'?'waiting':''}`}>{p.status==='PAUSED'?'Пауза':'На работе'}</span>
    </li>)}</ul>
    {day&&!day.available&&<p className="muted">{day.reason||'Рабочий день недоступен'}</p>}
    {people?.notes.map(note=><p className="muted dash-note" key={note}>{note}</p>)}
  </section>;
}
