import { BlockLoading } from './BlockLoading.js';
import { useDashboardQuery } from './DashboardSync.js';
import { useState } from 'react';
import type { OnShiftDto, WorkdayAction, WorkdayDto } from '@btx24/shared';
import { apiPost } from '../api.js';
import { fmtWhen } from '../format.js';
import { Avatar } from '../openlines/Avatar.js';
import { DashBadge } from '../openlines/RecentCalls.js';

export function OnShiftBlock({timezone}:{timezone:string}) {
  const roster=useDashboardQuery<OnShiftDto>('/workday/on-shift');
  const workday=useDashboardQuery<WorkdayDto>('/workday');
  const people=roster.data; const day=workday.data;
  const [actionError,setError]=useState(''); const [busy,setBusy]=useState(false);
  const error=actionError||roster.error||workday.error;
  const act=async(action:WorkdayAction)=>{
    if(busy)return;setBusy(true);setError('');
    try{await apiPost<WorkdayDto>(`/workday/${action}`);await Promise.all([roster.refresh(),workday.refresh()]);}
    catch(e){setError(e instanceof Error?e.message:'Не удалось изменить рабочий день');}finally{setBusy(false);}
  };
  const status=day?.status??'CLOSED';
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
    {day?.available&&<div className="on-shift-actions">
      {status==='CLOSED'&&<button type="button" className="primary" disabled={busy} onClick={()=>void act('open')}>Начать рабочий день</button>}
      {status==='OPENED'&&<button type="button" disabled={busy} onClick={()=>void act('pause')}>Пауза</button>}
      {status==='PAUSED'&&<button type="button" className="primary" disabled={busy} onClick={()=>void act('open')}>Продолжить рабочий день</button>}
      {(status==='OPENED'||status==='PAUSED'||status==='EXPIRED')&&<button type="button" disabled={busy} onClick={()=>void act('close')}>{status==='EXPIRED'?'Завершить прошлый день':'Завершить рабочий день'}</button>}
      {busy&&<span className="muted" role="status">Обновляем рабочий день…</span>}
    </div>}
    {people?.notes.map(note=><p className="muted dash-note" key={note}>{note}</p>)}
  </section>;
}
