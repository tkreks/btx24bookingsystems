import { useEffect, useRef, useState } from 'react';
import type { WorkdayAction, WorkdayDto, WorkdayStatus } from '@btx24/shared';
import { apiGet, apiPost } from '../api.js';

const LABEL: Record<WorkdayStatus, string> = {
  OPENED: 'На работе',
  PAUSED: 'Перерыв',
  CLOSED: 'День не начат',
  EXPIRED: 'День не закрыт',
};
const ACTIONS: Record<WorkdayStatus, { action: WorkdayAction; label: string; primary?: boolean }[]> = {
  CLOSED: [{ action: 'open', label: 'Начать рабочий день', primary: true }],
  OPENED: [
    { action: 'pause', label: 'Перерыв' },
    { action: 'close', label: 'Завершить рабочий день' },
  ],
  PAUSED: [
    { action: 'open', label: 'Продолжить работу', primary: true },
    { action: 'close', label: 'Завершить рабочий день' },
  ],
  EXPIRED: [{ action: 'close', label: 'Закрыть прошлый день', primary: true }],
};
/** Статус обновляем раз в минуту (день могли начать/закрыть в самом Битрикс24). */
const POLL_MS = 60_000;

/** «Начать / перерыв / завершить» свой рабочий день Битрикс24 — правый верхний угол. */
export function WorkdayButton({ timezone }: { timezone: string }) {
  const [day, setDay] = useState<WorkdayDto | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    const load = () =>
      apiGet<WorkdayDto>('/workday').then(
        (d) => active && setDay(d),
        () => undefined,
      );
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  if (!day) return null;
  if (!day.available)
    return (
      <span className="workday-chip off" title={day.reason ?? 'Учёт рабочего времени недоступен'}>
        Рабочий день недоступен
      </span>
    );
  const status = day.status ?? 'CLOSED';

  const act = async (action: WorkdayAction) => {
    setBusy(true);
    setError('');
    try {
      setDay(await apiPost<WorkdayDto>(`/workday/${action}`));
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="workday" ref={ref}>
      <button
        className={`workday-chip ${status.toLowerCase()}`}
        aria-expanded={open}
        aria-label={`Рабочий день: ${LABEL[status]}`}
        onClick={() => setOpen(!open)}
      >
        <span className="workday-dot" aria-hidden="true" />
        {LABEL[status]}
        {status === 'OPENED' && day.duration && <span className="workday-time">{day.duration.slice(0, 5)}</span>}
      </button>
      {open && (
        <div className="workday-menu" role="menu">
          {day.timeStart && (
            <p className="muted">
              Начат в{' '}
              {new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, hour: '2-digit', minute: '2-digit' }).format(new Date(day.timeStart))}
              {day.timeLeaks && day.timeLeaks !== '00:00:00' ? ` · перерывы ${day.timeLeaks.slice(0, 5)}` : ''}
            </p>
          )}
          {ACTIONS[status].map((a) => (
            <button
              key={a.action}
              role="menuitem"
              className={a.primary ? 'primary' : a.action === 'close' ? 'danger' : ''}
              disabled={busy}
              onClick={() => void act(a.action)}
            >
              {a.label}
            </button>
          ))}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
