import { useEffect, useMemo, useState } from 'react';
import { todayIn, type CalendarBooking, type CalendarDay, type SessionInfo } from '@btx24/shared';
import { apiGet, ApiRequestError } from '../api.js';
import { fitFrame, type PlacementContext } from '../b24.js';
import { fmtDayTitle, shiftDate } from '../format.js';
import { AdminPanel } from './AdminPanel.js';
import { BookingDetails } from './BookingDetails.js';
import { DayGrid } from './DayGrid.js';
import { DayList } from './DayList.js';

type View = 'grid' | 'list';

const VIEW_KEY = 'btx24.view';
const narrow = () => window.matchMedia('(max-width: 760px)').matches;

function initialView(): View {
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    if (saved === 'grid' || saved === 'list') return saved;
  } catch {
    /* localStorage недоступен (приватный режим Safari) */
  }
  return narrow() ? 'list' : 'grid';
}

export function CalendarPage({ session, placement }: { session: SessionInfo; placement: PlacementContext }) {
  const tz = session.portal.timezone;
  const [date, setDate] = useState(() => todayIn(tz));
  const [view, setView] = useState<View>(initialView);
  // Ответ привязан к дате запроса: «загружается» = ответа на текущую дату ещё нет. Пока он идёт,
  // показываем прошлый день приглушённым; поздний ответ на старую дату отбрасывается.
  const [resp, setResp] = useState<{ date: string; day: CalendarDay | null; error: string | null } | null>(null);
  const [selected, setSelected] = useState<CalendarBooking | null>(null);
  const [adminOpen, setAdminOpen] = useState(false);
  const loading = resp?.date !== date;
  const day = resp?.day ?? null;
  const error = loading ? null : (resp?.error ?? null);

  useEffect(() => {
    let cancelled = false;
    apiGet<CalendarDay>(`/calendar?date=${date}`).then(
      (d) => !cancelled && setResp({ date, day: d, error: null }),
      (e) => !cancelled && setResp((prev) => ({ date, day: prev?.day ?? null, error: e instanceof ApiRequestError ? e.message : 'Не удалось загрузить календарь' })),
    );
    return () => {
      cancelled = true;
    };
  }, [date]);
  useEffect(() => fitFrame(), [day, view, selected, adminOpen]);

  const switchView = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* без сохранения */
    }
  };

  const dealBookings = useMemo(() => (placement.dealId && day ? day.bookings.filter((b) => b.dealId === placement.dealId).length : 0), [placement.dealId, day]);

  return (
    <div className="page">
      <header className="toolbar">
        <div className="toolbar-title">
          <h1>Бронирование</h1>
          <span className="muted">{fmtDayTitle(date, tz)}</span>
        </div>
        <div className="toolbar-controls">
          <button aria-label="Предыдущий день" onClick={() => setDate(shiftDate(date, -1))}>‹</button>
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="Дата" />
          <button aria-label="Следующий день" onClick={() => setDate(shiftDate(date, 1))}>›</button>
          <button onClick={() => setDate(todayIn(tz))}>Сегодня</button>
          <div className="segmented" role="group" aria-label="Вид">
            <button className={view === 'grid' ? 'active' : ''} onClick={() => switchView('grid')}>Сетка</button>
            <button className={view === 'list' ? 'active' : ''} onClick={() => switchView('list')}>Список</button>
          </div>
          {session.user.isAdmin && <button aria-label="Настройки" onClick={() => setAdminOpen(true)}>⚙</button>}
        </div>
      </header>

      {session.readOnly && <div className="notice">Режим просмотра: изменения в Битрикс24 пока отключены.</div>}
      {placement.dealId && (
        <div className="notice deal">
          Сделка #{placement.dealId}: {dealBookings ? `броней на эту дату — ${dealBookings}` : 'на эту дату броней нет'}
        </div>
      )}
      {error && <div className="notice error">{error}</div>}

      <main className={loading ? 'loading' : ''}>
        {day && (view === 'grid' ? <DayGrid day={day} highlightDealId={placement.dealId} onSelect={setSelected} /> : <DayList day={day} highlightDealId={placement.dealId} onSelect={setSelected} />)}
        {!day && loading && <div className="muted pad">Загрузка броней…</div>}
      </main>

      {selected && day && <BookingDetails booking={selected} day={day} onClose={() => setSelected(null)} />}
      {adminOpen && <AdminPanel onClose={() => setAdminOpen(false)} />}
    </div>
  );
}
