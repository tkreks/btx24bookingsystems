import { useEffect, useRef, useState } from 'react';
import type { WorkdayAction, WorkdayDto } from '@btx24/shared';
import { apiPost } from '../api.js';
import { useDashboardQuery } from '../dashboard/DashboardSync.js';
import { Icon } from '../openlines/icons.js';

/**
 * Свой рабочий день Битрикс24 — в шапке дашборда рядом с ФИО: «▶ Начать», «⏸ Пауза», «⏹ Завершить»
 * (с необязательным комментарием — `REPORT` в `timeman.close`). Компактно, без фона.
 */
export function WorkdayControls({ timezone }: { timezone: string }) {
  const { data: day, refresh } = useDashboardQuery<WorkdayDto>('/workday');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [closing, setClosing] = useState(false);
  const [report, setReport] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!closing) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setClosing(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [closing]);

  if (!day?.available) return null;
  const status = day.status ?? 'CLOSED';

  const act = async (action: WorkdayAction, body?: { report: string }) => {
    setBusy(true);
    setError('');
    try {
      // Остальные блоки (кто на смене) обновятся сами: любое изменение будит дашборд.
      await apiPost<WorkdayDto>(`/workday/${action}`, body);
      await refresh();
      setClosing(false);
      setReport('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось изменить рабочий день');
    } finally {
      setBusy(false);
    }
  };
  const started = day.timeStart
    ? new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, hour: '2-digit', minute: '2-digit' }).format(new Date(day.timeStart))
    : null;

  return (
    <div className="workday-controls" ref={ref}>
      {status === 'CLOSED' && (
        <button type="button" className="workday-btn start" disabled={busy} onClick={() => void act('open')} title="Начать рабочий день">
          <Icon name="play" size={14} /> Начать
        </button>
      )}
      {status === 'PAUSED' && (
        <button type="button" className="workday-btn start" disabled={busy} onClick={() => void act('open')} title="Продолжить рабочий день после паузы">
          <Icon name="play" size={14} /> Продолжить
        </button>
      )}
      {status === 'OPENED' && (
        <button type="button" className="workday-btn" disabled={busy} onClick={() => void act('pause')} title={started ? `На работе с ${started}` : 'Пауза'}>
          <Icon name="pause" size={14} /> Пауза
        </button>
      )}
      {(status === 'OPENED' || status === 'PAUSED' || status === 'EXPIRED') && (
        <button
          type="button"
          className="workday-btn stop"
          disabled={busy}
          aria-expanded={closing}
          onClick={() => setClosing(!closing)}
          title={status === 'EXPIRED' ? 'Прошлый рабочий день не закрыт — завершить' : 'Завершить рабочий день'}
        >
          <Icon name="stop" size={14} /> Завершить
        </button>
      )}
      {closing && (
        <form
          className="workday-menu"
          onSubmit={(e) => {
            e.preventDefault();
            void act('close', { report: report.trim() });
          }}
        >
          <p className="muted">
            {status === 'EXPIRED' ? 'Прошлый день не закрыт — он завершится рекомендованным временем.' : started ? `Начат в ${started}` : 'Завершить рабочий день'}
            {day.timeLeaks && day.timeLeaks !== '00:00:00' ? ` · паузы ${day.timeLeaks.slice(0, 5)}` : ''}
          </p>
          <label>
            Комментарий <span className="muted">(если нужно)</span>
            <textarea rows={2} maxLength={1000} value={report} autoFocus onChange={(e) => setReport(e.target.value)} />
          </label>
          <div className="form-actions">
            <button type="button" onClick={() => setClosing(false)} disabled={busy}>
              Отмена
            </button>
            <button type="submit" className="primary" disabled={busy}>
              {busy ? 'Завершаем…' : 'Завершить день'}
            </button>
          </div>
        </form>
      )}
      {day.pending && (
        <span className="workday-pending" role="status" title="Битрикс24 сейчас недоступен — действие сохранено в приложении и уйдёт в Битрикс24 автоматически">
          ⟳ ждёт Битрикс24
        </span>
      )}
      {error && (
        <span className="workday-error" role="alert" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}
