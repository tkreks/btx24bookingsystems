import { useCallback, useEffect, useRef, useState } from 'react';
import { todayIn, type ViewerBookingDto, type ViewerDayDto, type ViewerSessionDto } from '@btx24/shared';
import { apiGet, ApiRequestError } from '../api.js';
import { shiftDate } from '../format.js';
import { BookingSheet } from './BookingDetails.js';
import { ViewerAvailability } from './ViewerAvailability.js';
import { ViewerCalendar } from './ViewerCalendar.js';
import { ViewerList } from './ViewerList.js';
import { CalendarIcon } from './icons.js';
import { VIEWER_MODES, type ViewerMode } from './viewer-model.js';

const MODE_KEY = 'btx24.viewer.mode';
const GROUP_KEY = 'btx24.viewer.group';
const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* без запоминания */
  }
};
const isMode = (v: string | null): v is ViewerMode => VIEWER_MODES.some((m) => m.id === v);
/** Телефон — всегда «Список» при открытии; на компьютере — последний выбранный режим. */
const initialMode = (): ViewerMode => {
  const saved = read(MODE_KEY);
  return window.matchMedia?.('(max-width: 720px)').matches || !isMode(saved) ? 'list' : saved;
};
const longDate = (date: string) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${date}T12:00:00Z`));
const weekday = (date: string) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', weekday: 'long' }).format(new Date(`${date}T12:00:00Z`));

async function logoutExternal(): Promise<void> {
  await fetch('/api/external/logout', { method: 'POST', headers: { 'X-Btx24-Standalone': '1' } }).catch(() => undefined);
  window.location.assign('/');
}

/**
 * Приложение внешнего пользователя (роль «просмотр», вход по логину и паролю): свой дашборд —
 * пока один блок «Бронирования» на выбранный день (список, календарь, доступность).
 */
export function ViewerApp({ session }: { session: ViewerSessionDto }) {
  const tz = session.portal.timezone;
  const today = todayIn(tz);
  const [date, setDate] = useState(today);
  const [mode, setModeState] = useState<ViewerMode>(initialMode);
  const savedGroup = read(GROUP_KEY) ?? '';
  const [groupId, setGroupState] = useState(session.groups.some((g) => g.id === savedGroup) ? savedGroup : '');
  const [data, setData] = useState<{ key: string; day: ViewerDayDto } | null>(null);
  const [failed, setFailed] = useState<{ key: string; message: string } | null>(null);
  const [sheet, setSheet] = useState<ViewerBookingDto | null>(null);
  const [attempt, setAttempt] = useState(0);
  const picker = useRef<HTMLInputElement>(null);
  const key = `${date}|${groupId}`;

  const setMode = (m: ViewerMode) => {
    setModeState(m);
    write(MODE_KEY, m);
  };
  const setGroup = (g: string) => {
    setGroupState(g);
    write(GROUP_KEY, g);
  };

  useEffect(() => {
    let active = true;
    const k = `${date}|${groupId}|${attempt}`;
    apiGet<ViewerDayDto>(`/external/day?date=${date}${groupId ? `&groupId=${encodeURIComponent(groupId)}` : ''}`).then(
      (day) => active && setData({ key: `${date}|${groupId}`, day }),
      (e) => {
        if (!active) return;
        // Сессия истекла или пароль сменили — на страницу входа.
        if (e instanceof ApiRequestError && e.status === 401) return window.location.assign('/');
        setFailed({ key: k, message: e instanceof Error ? e.message : 'Не удалось загрузить бронирования' });
      },
    );
    return () => {
      active = false;
    };
  }, [date, groupId, attempt]);

  // Данные дня обновляются сами раз в 2 минуты, пока вкладка открыта.
  useEffect(() => {
    const t = window.setInterval(() => document.visibilityState === 'visible' && setAttempt((n) => n + 1), 120_000);
    return () => window.clearInterval(t);
  }, []);

  const close = useCallback(() => setSheet(null), []);
  const day = data?.key === key ? data.day : null;
  const error = failed?.key === `${key}|${attempt}` ? failed.message : '';
  const empty = `На ${new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', day: 'numeric', month: 'long' }).format(new Date(`${date}T12:00:00Z`))} бронирований нет`;

  return (
    <div className="vw-app">
      <header className="vw-top">
        <div className="vw-top-row">
          {session.groups.length > 1 ? (
            <select className="vw-group" aria-label="Группа ресурсов" value={groupId} onChange={(e) => setGroup(e.target.value)}>
              <option value="">Все группы</option>
              {session.groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="vw-group-name">{session.groups[0]?.name ?? ''}</span>
          )}
          <button type="button" className="vw-logout" title={`Выйти (${session.login})`} onClick={() => void logoutExternal()}>
            Выйти
          </button>
        </div>
        <div className="vw-date">
          <label className="vw-cal-btn" title="Выбрать дату">
            <CalendarIcon size={20} />
            <input ref={picker} type="date" aria-label="Выбрать дату" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
          </label>
          <button type="button" className="vw-arrow" aria-label="Предыдущий день" onClick={() => setDate(shiftDate(date, -1))}>
            ‹
          </button>
          <button type="button" className="vw-date-label" onClick={() => (picker.current?.showPicker ? picker.current.showPicker() : picker.current?.focus())}>
            <b>{longDate(date)}</b>
            <span className="muted">{date === today ? 'сегодня' : weekday(date)}</span>
          </button>
          <button type="button" className="vw-arrow" aria-label="Следующий день" onClick={() => setDate(shiftDate(date, 1))}>
            ›
          </button>
          {date !== today && (
            <button type="button" className="vw-today" onClick={() => setDate(today)}>
              Сегодня
            </button>
          )}
        </div>
        <div className="vw-modes" role="tablist" aria-label="Вид">
          {VIEWER_MODES.map((m) => (
            <button key={m.id} type="button" role="tab" aria-selected={mode === m.id} className={mode === m.id ? 'active' : ''} onClick={() => setMode(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
      </header>

      <main className="vw-main">
        {error && (
          <div className="vw-error" role="alert">
            <p>{error}</p>
            <button type="button" onClick={() => setAttempt((n) => n + 1)}>
              Повторить
            </button>
          </div>
        )}
        {!day && !error && (
          <div className="vw-skeleton" aria-label="Загрузка">
            <i />
            <i />
            <i />
          </div>
        )}
        {day && mode === 'list' && <ViewerList day={day} onOpen={setSheet} emptyText={day.resources.length ? empty : 'Нет доступных ресурсов для отображения'} />}
        {day && mode === 'calendar' && <ViewerCalendar day={day} onOpen={setSheet} />}
        {day && mode === 'availability' && <ViewerAvailability day={day} onOpen={setSheet} />}
      </main>
      {sheet && day && <BookingSheet b={sheet} day={day} onClose={close} />}
    </div>
  );
}
