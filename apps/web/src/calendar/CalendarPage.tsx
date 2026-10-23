import { useEffect, useMemo, useState } from 'react';
import {
  todayIn,
  type CalendarBooking,
  type CalendarDay,
  type CalendarView,
  type ClientBookingDto,
  type ClientBookingsDto,
  type MyGroupDto,
  type SessionInfo,
} from '@btx24/shared';
import { apiGet, ApiRequestError } from '../api.js';
import { fitFrame, type PlacementContext } from '../b24.js';
import { fmtDateTime, fmtDayTitle, fmtTime, shiftDate } from '../format.js';
import { ChatsPage } from '../openlines/ChatsPage.js';
import { BookingAlertsPage } from '../bookings/BookingAlertsPage.js';
import { BookingForm } from '../bookings/BookingForm.js';
import { CertificatesPage } from '../certificates/CertificatesPage.js';
import { ErrorBoundary } from '../ErrorBoundary.js';
import { PaymentDialog } from '../bookings/PaymentDialog.js';
import { dayKey } from '../openlines/chat-list.js';
import { HeadDashboardPage } from '../openlines/HeadDashboardPage.js';
import { DashboardPage } from '../openlines/DashboardPage.js';
import { TemplatesPage } from '../openlines/TemplatesPage.js';
import { SettingsPanel } from '../settings/SettingsPanel.js';
import { ThemeToggle } from '../theme/ThemeToggle.js';
import { WorkdayButton } from '../workday/WorkdayButton.js';
import { BookingDetails } from './BookingDetails.js';
import { DayAvailability } from './DayAvailability.js';
import { DayGrid } from './DayGrid.js';
import { ResourceStopDialog } from './ResourceStopDialog.js';
import { DayList } from './DayList.js';
import { isNarrow, nextView, parseView, VIEW_ICONS, VIEW_TITLES, viewForGroup } from './views.js';

const VIEW_KEY = 'btx24.view';
const GROUP_KEY = 'btx24.group';

function savedGroup(): string | null {
  try {
    return localStorage.getItem(GROUP_KEY);
  } catch {
    return null;
  }
}
function initialView(): CalendarView {
  try {
    const saved = parseView(localStorage.getItem(VIEW_KEY));
    if (saved) return saved;
  } catch {
    /* localStorage недоступен (приватный режим Safari) */
  }
  return isNarrow() ? 'list' : 'calendar';
}

export function CalendarPage({
  session: initialSession,
  placement,
}: {
  session: SessionInfo;
  placement: PlacementContext;
}) {
  // Сессия может обновиться без перезагрузки: доступ к настройкам по временному паролю.
  const [session, setSession] = useState(initialSession);
  const tz = session.portal.timezone;
  const [date, setDate] = useState(() => todayIn(tz));
  const [view, setView] = useState<CalendarView>(initialView);
  // Переключал ли пользователь вид в этой группе (как в прототипе: при смене группы сбрасывается).
  const [userChosen, setUserChosen] = useState(false);
  const [groups, setGroups] = useState<MyGroupDto[] | null>(null);
  const [groupId, setGroupId] = useState<string | null>(savedGroup);
  // Ответ привязан к ключу запроса (дата + группа): «загружается» = ответа на текущий ключ ещё
  // нет. Пока он идёт, показываем прошлый день приглушённым; поздний ответ на старый ключ
  // отбрасывается.
  const [resp, setResp] = useState<{ key: string; day: CalendarDay | null; error: string | null } | null>(null);
  const [selected, setSelected] = useState<CalendarBooking | null>(null);
  const [adminOpen, setAdminOpen] = useState(false);
  // Открытая форма брони: из «+ Бронь» — на текущий день; кликом в календаре — ресурс и время.
  const [bookingForm, setBookingForm] = useState<{ date: string; time?: string; resourceId?: number } | null>(null);
  const [payment, setPayment] = useState<{ dealId: number; bookingId: number | null; amount?: number | null; fixedDeal?: boolean } | null>(null);
  const [createdNote, setCreatedNote] = useState('');
  const [dealBookingsInfo, setDealBookings] = useState<ClientBookingsDto | null>(null);
  const [settingsRevision, setSettingsRevision] = useState(0);
  // Стоп ресурса: окно и перезагрузка дня после изменений.
  const [stopFor, setStopFor] = useState<number | null>(null);
  const [dayRev, setDayRev] = useState(0);
  const [groupsError, setGroupsError] = useState<string | null>(null);
  // Экран приложения. Состояние календаря (дата, вид) живёт здесь и не теряется при переходах.
  // Ссылка из чата уведомлений (`?alert=<id>`) открывает сразу «Уведомления о бронях».
  const [screen, setScreen] = useState<
    | { name: 'calendar' }
    | { name: 'dashboard' }
    | { name: 'head' }
    | { name: 'chats'; chatId?: number; waiting?: boolean }
    | { name: 'alerts'; alertId?: string | null }
    | { name: 'templates' }
    | { name: 'certificates' }
  >(() => {
    const alertId = new URLSearchParams(window.location.search).get('alert');
    if (alertId) return { name: 'alerts', alertId };
    // Открыли не из сделки — сначала дашборд (руководителю — свой); из карточки сделки — календарь.
    return placement.dealId ? { name: 'calendar' } : initialSession.headAssigned ? { name: 'head' } : { name: 'dashboard' };
  });

  useEffect(() => {
    let active = true;
    apiGet<MyGroupDto[]>('/groups').then(
      (value) => {
        if (active) {
          setGroups(value);
          setGroupsError(null);
        }
      },
      (e) => {
        if (active) setGroupsError(e instanceof Error ? e.message : 'Не удалось загрузить группы');
      },
    );
    return () => {
      active = false;
    };
  }, [settingsRevision]);

  // Сохранённая группа могла пропасть (исключили, архивировали) — берём первую доступную.
  const activeGroup = groups?.find((g) => g.id === groupId) ?? groups?.[0] ?? null;
  const query = `date=${date}${activeGroup ? `&groupId=${encodeURIComponent(activeGroup.id)}` : ''}`;
  const loading = resp?.key !== query;

  // Вид по умолчанию группы (ПК / телефон) или «доступность» для заезда/выезда — при смене
  // группы или её настроек. Считается при рендере, без эффекта (паттерн React «state from props»).
  const viewKey = activeGroup
    ? `${activeGroup.id}:${activeGroup.views.desktop}:${activeGroup.views.mobile}:${activeGroup.bookingMode}`
    : '';
  const [appliedViewKey, setAppliedViewKey] = useState('');
  if (activeGroup && viewKey !== appliedViewKey) {
    setAppliedViewKey(viewKey);
    setView(viewForGroup(activeGroup, view, userChosen, isNarrow()));
  }
  const day = resp?.day ?? null;
  const error = loading ? null : (resp?.error ?? null);

  useEffect(() => {
    if (groups === null) return;
    let cancelled = false;
    apiGet<CalendarDay>(`/calendar?${query}`).then(
      (d) => !cancelled && setResp({ key: query, day: d, error: null }),
      (e) =>
        !cancelled &&
        setResp((prev) => ({
          key: query,
          day: prev?.day ?? null,
          error: e instanceof ApiRequestError ? e.message : 'Не удалось загрузить календарь',
        })),
    );
    return () => {
      cancelled = true;
    };
  }, [query, groups, dayRev]);

  const chooseGroup = (id: string) => {
    setGroupId(id);
    setUserChosen(false);
    try {
      localStorage.setItem(GROUP_KEY, id);
    } catch {
      /* без сохранения */
    }
  };

  const [dealTarget, setDealTarget] = useState<ClientBookingDto | null>(null);
  const [targetGroupApplied, setTargetGroupApplied] = useState(false);
  // Встройка в сделку: календарь открывается на дате брони этой сделки (ближайшей предстоящей,
  // иначе последней) и в группе её ресурса; брони нет — сегодня.
  useEffect(() => {
    if (!placement.dealId) return;
    let active = true;
    apiGet<ClientBookingsDto>(`/deals/${placement.dealId}/bookings`).then(
      (r) => {
        if (!active) return;
        const own = (list: ClientBookingDto[]) => list.find((b) => b.dealId === placement.dealId);
        const b = own(r.upcoming) ?? own(r.recent);
        if (b) {
          setDate(dayKey(b.start, tz));
          setDealTarget(b);
        }
        setDealBookings(r);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [placement.dealId, tz]);

  // Бронь сделки в другой группе — переключаемся на неё один раз (выбор сотрудника не сохраняем).
  // Группа определяется только ресурсом брони (ресурс — ровно в одной группе), не воронкой сделки.
  const targetGroup = dealTarget && groups ? groups.find((x) => dealTarget.resourceIds.some((id) => x.resourceIds.includes(id))) ?? null : null;
  if (dealTarget && groups && !targetGroupApplied) {
    setTargetGroupApplied(true);
    if (targetGroup && targetGroup.id !== activeGroup?.id) setGroupId(targetGroup.id);
  }

  useEffect(() => fitFrame(), [day, view, selected, adminOpen, screen]);

  const switchView = (v: CalendarView) => {
    setView(v);
    setUserChosen(true);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* без сохранения */
    }
  };

  const dealBookings = useMemo(
    () => (placement.dealId && day ? day.bookings.filter((b) => b.dealId === placement.dealId).length : 0),
    [placement.dealId, day],
  );

  // Права на открытые линии — подсказка интерфейсу; проверяет сервер.
  const permissions = new Set(groups?.flatMap((g) => g.permissions) ?? []);
  const openlinesRead = session.canManageApp || permissions.has('openlines.read');
  const openlinesSend = session.canManageApp || permissions.has('openlines.send');
  const bookingsView = session.canManageApp || permissions.has('booking.details');
  // Стоп ресурса — право менять брони в группе (сервер проверит по группе ресурса).
  const canStop = session.canManageApp || !!activeGroup?.permissions.includes('booking.edit');
  // Бронь кликом в календаре — только в группе, где у сотрудника есть право создавать.
  const createAt =
    activeGroup?.permissions.includes('booking.create')
      ? (resourceId: number, start: string | null) =>
          setBookingForm(
            start ? { date: dayKey(start, tz), time: fmtTime(start, tz), resourceId } : { date, resourceId },
          )
      : undefined;

  if (screen.name === 'alerts')
    return (
      <BookingAlertsPage
        timezone={tz}
        focusId={screen.alertId}
        canEdit={session.canManageApp || permissions.has('booking.edit')}
        canCancel={session.canManageApp || permissions.has('booking.cancel')}
        canCreate={session.canManageApp || permissions.has('booking.create')}
        onBack={() => setScreen({ name: 'dashboard' })}
      />
    );

  if (screen.name === 'certificates') return <CertificatesPage timezone={tz} onBack={() => setScreen({ name: 'dashboard' })} />;

  if (screen.name === 'templates')
    return (
      <>
        <TemplatesPage
          admin={session.canManageApp}
          onBack={() => setScreen({ name: 'dashboard' })}
          onSettings={session.canManageApp ? () => setAdminOpen(true) : undefined}
        />
        {adminOpen && session.canManageApp && (
          <SettingsPanel
            timezone={tz}
            temporary={session.settingsAccessUntil}
            onClose={() => setAdminOpen(false)}
            onChanged={() => setSettingsRevision((n) => n + 1)}
          />
        )}
      </>
    );

  // Настройки открываются только с дашборда (решение владельца): админам и по временному паролю.
  if (screen.name === 'head') return <HeadDashboardPage session={session} onManager={() => setScreen({ name: 'dashboard' })} />;
  if (screen.name === 'dashboard')
    return (
      <>
        <DashboardPage
          session={session}
          openlines={openlinesRead}
          onBack={() => setScreen({ name: 'calendar' })}
          onChats={(o) => setScreen({ name: 'chats', ...o })}
          bookingAlerts={bookingsView}
          onAlerts={() => setScreen({ name: 'alerts' })}
          onSettings={() => setAdminOpen(true)}
          onTemplates={openlinesSend ? () => setScreen({ name: 'templates' }) : undefined}
          onCertificates={() => setScreen({ name: 'certificates' })}
          onHead={session.isHead ? () => setScreen({ name: 'head' }) : undefined}
          onSession={(s) => {
            setSession(s);
            setSettingsRevision((n) => n + 1);
          }}
        />
        {adminOpen && session.canManageApp && (
          <SettingsPanel
            timezone={tz}
            temporary={session.settingsAccessUntil}
            onClose={() => setAdminOpen(false)}
            onChanged={() => setSettingsRevision((n) => n + 1)}
          />
        )}
      </>
    );
  if (screen.name === 'chats')
    return (
      <ChatsPage
        timezone={tz}
        canSend={openlinesSend}
        initialChatId={screen.chatId}
        initialWaiting={screen.waiting}
        onClose={() => setScreen({ name: 'dashboard' })}
        groups={groups ?? []}
        onOpenDay={(d) => {
          setDate(d);
          setScreen({ name: 'calendar' });
        }}
      />
    );

  return (
    <div className="page">
      <header className="toolbar">
        <div className="toolbar-title">
          <h1>Бронирование</h1>
          {groups && groups.length > 1 && (
            <select
              className="group-select"
              value={activeGroup?.id ?? ''}
              onChange={(e) => chooseGroup(e.target.value)}
              aria-label="Группа"
            >
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          )}
          {groups && groups.length === 1 && <span className="pill">{groups[0].name}</span>}
          <span className="muted">{fmtDayTitle(date, tz)}</span>
        </div>
        <div className="toolbar-controls">
          <button aria-label="Предыдущий день" onClick={() => setDate(shiftDate(date, -1))}>
            ‹
          </button>
          <input
            type="date"
            value={date}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            aria-label="Дата"
          />
          <button aria-label="Следующий день" onClick={() => setDate(shiftDate(date, 1))}>
            ›
          </button>
          <button onClick={() => setDate(todayIn(tz))}>Сегодня</button>
          <button
            className="view-toggle"
            title={`Показать: ${VIEW_TITLES[nextView(view)].toLowerCase()}`}
            onClick={() => switchView(nextView(view))}
          >
            {VIEW_ICONS[nextView(view)]} <span className="view-toggle-text">{VIEW_TITLES[nextView(view)]}</span>
          </button>
          {(session.canManageApp || permissions.has('booking.create')) && (
            <button className="primary" onClick={() => setBookingForm({ date })}>
              + Бронь
            </button>
          )}
          <ThemeToggle />
          <WorkdayButton timezone={tz} />
          <button
            className="home-button"
            aria-label="Мой дашборд"
            title="Мой дашборд"
            onClick={() => setScreen({ name: 'dashboard' })}
          >
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M3 10.5 12 3l9 7.5" />
              <path d="M5 9.5V21h14V9.5" />
              <path d="M9 21v-7h6v7" />
            </svg>
          </button>
        </div>
      </header>

      {session.readOnly && <div className="notice">Режим просмотра: изменения в Битрикс24 пока отключены.</div>}
      {groups && groups.length === 0 && session.canManageApp && (
        <div className="notice">Группы ещё не настроены — показаны все ресурсы портала.</div>
      )}
      {placement.dealId && (
        <div className="notice deal">
          {dealTarget ? (
            <>
              Бронь сделки #{placement.dealId}: <b>{fmtDateTime(dealTarget.start, tz)} — {fmtDateTime(dealTarget.end, tz)}</b>
              {dealTarget.resources.length > 0 && ` · ${dealTarget.resources.join(', ')}`}
              {dayKey(dealTarget.start, tz) !== date && (
                <button className="link" onClick={() => setDate(dayKey(dealTarget.start, tz))}>
                  Показать
                </button>
              )}
              {dealTarget.bookingId === null
                ? dayKey(dealTarget.start, tz) === date && dealBookings
                  ? ' · удалена в Битрикс24 — откройте её в календаре и решите: оставить или удалить из приложения'
                  : ' · в Битрикс24 этой брони уже нет (удалена) — даты и ресурс из сделки'
                : dayKey(dealTarget.start, tz) === date &&
                  !dealBookings &&
                  (targetGroup ? ' · в календаре её нет — обновите страницу' : ' · ресурс брони не входит в ваши группы')}
              {day?.bookings.some((x) => x.dealId === placement.dealId && x.missing) &&
                ' · удалена в Битрикс24 и ждёт решения — откройте бронь: оставить или удалить из приложения'}
            </>
          ) : (
            <>Сделка #{placement.dealId}: брони нет — показан сегодняшний день.</>
          )}
        </div>
      )}
      {groupsError && (
        <div className="notice error" role="alert">
          {groupsError}
        </div>
      )}
      {error && <div className="notice error">{error}</div>}

      <main className={loading ? 'loading' : ''}>
        {day && view === 'calendar' && (
          <DayGrid day={day} highlightDealId={placement.dealId} onSelect={setSelected} onCreate={createAt} onStop={canStop ? setStopFor : undefined} />
        )}
        {day && view === 'list' && (
          <DayList
            day={day}
            groupName={activeGroup?.name ?? ''}
            highlightDealId={placement.dealId}
            onSelect={setSelected}
            onCreate={createAt}
          />
        )}
        {day && view === 'availability' && (
          <DayAvailability
            day={day}
            groupName={activeGroup?.name ?? ''}
            highlightDealId={placement.dealId}
            onSelect={setSelected}
            onCreate={createAt}
          />
        )}
        {!day && loading && <div className="muted pad">Загрузка броней…</div>}
      </main>

      {createdNote && <div className="notice">{createdNote}</div>}
      {selected && day && (
        <BookingDetails
          booking={selected}
          day={day}
          groupId={activeGroup?.id ?? null}
          canEdit={!!activeGroup?.permissions.includes('booking.edit')}
          canCancel={!!activeGroup?.permissions.includes('booking.cancel')}
          canCreate={!!activeGroup?.permissions.includes('booking.create')}
          onResolved={(note) => {
            setSelected(null);
            setCreatedNote(note);
            setSettingsRevision((n) => n + 1);
          }}
          onClose={() => setSelected(null)}
          onChanged={() => setSettingsRevision((n) => n + 1)}
          onCancelled={(r) => {
            setSelected(null);
            setCreatedNote(`Бронь #${r.bookingId} снята.${r.warnings.length ? ` ${r.warnings.join(' ')}` : ''}`);
            setSettingsRevision((n) => n + 1);
          }}
        />
      )}
      {stopFor !== null && day && (
        <ResourceStopDialog
          resource={{ id: stopFor, name: day.resources.find((r) => r.id === stopFor)?.name ?? `Ресурс #${stopFor}` }}
          timezone={tz}
          date={date}
          onClose={() => setStopFor(null)}
          onChanged={() => setDayRev((n) => n + 1)}
        />
      )}
      {bookingForm && (
        <ErrorBoundary where="booking-form" onClose={() => setBookingForm(null)}>
          <BookingForm
            groups={groups ?? []}
            timezone={tz}
            context={{
              ...bookingForm,
              groupId: activeGroup?.id ?? null,
              dealId: placement.dealId,
              contactId: dealBookingsInfo?.contactId ?? null,
              openDeals: dealBookingsInfo?.openDeals ?? [],
            }}
            onClose={() => setBookingForm(null)}
            onDone={(r) => {
              setBookingForm(null);
              if (r.payment && r.dealId && groups?.some((g) => g.permissions.includes('payment.send')))
                setPayment({ dealId: r.dealId, bookingId: r.booking?.bookingId ?? null, amount: r.payment.amount, fixedDeal: r.payment.fixedDeal });
              setCreatedNote(r.note);
              setSettingsRevision((n) => n + 1);
            }}
          />
        </ErrorBoundary>
      )}
      {payment && (
        <PaymentDialog
          dealId={payment.dealId}
          bookingId={payment.bookingId}
          initialAmount={payment.amount}
          fixedDeal={payment.fixedDeal}
          timezone={tz}
          onClose={() => setPayment(null)}
          onCreateBooking={() => {
            setPayment(null);
            setBookingForm({ date });
          }}
        />
      )}
    </div>
  );
}
