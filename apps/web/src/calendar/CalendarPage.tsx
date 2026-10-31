import { freshPoll } from '../fresh-poll.js';
import { DashboardSyncProvider, dashboardScope } from '../dashboard/DashboardSync.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  todayIn,
  type CalendarBooking,
  type CalendarDay,
  type CalendarView,
  type ClientBookingDto,
  type ClientBookingsDto,
  type MyGroupDto,
  type NewDealResultDto,
  type SessionInfo,
} from '@btx24/shared';
import { apiGet, apiPost, ApiRequestError } from '../api.js';
import { fitFrame, openCrm, type PlacementContext } from '../b24.js';
import { DealBookingWarning, DealHome } from '../deal/DealHome.js';
import { DealOverviewPage } from '../deal/DealOverviewPage.js';
import { fmtDateTime, fmtDayTitle, fmtTime, shiftDate } from '../format.js';
import { ChatsPage } from '../openlines/ChatsPage.js';
import { BookingAlertsPage } from '../bookings/BookingAlertsPage.js';
import { BookingForm } from '../bookings/BookingForm.js';
import { CertificatesPage } from '../certificates/CertificatesPage.js';
import { ErrorBoundary } from '../ErrorBoundary.js';
import { PaymentDialog } from '../bookings/PaymentDialog.js';
import { dayKey } from '../openlines/chat-list.js';
import { DashboardPage } from '../openlines/DashboardPage.js';
import { TemplatesPage } from '../openlines/TemplatesPage.js';
import { SettingsPanel } from '../settings/SettingsPanel.js';
import { ThemeToggle } from '../theme/ThemeToggle.js';
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

type AppScreen =
  | { name: 'calendar' }
  | { name: 'dashboard' }
  | { name: 'deal-home' }
  | { name: 'deal' }
  | { name: 'chats'; chatId?: number; waiting?: boolean; from?: string; to?: string; deal?: boolean }
  | { name: 'alerts'; alertId?: string | null }
  | { name: 'templates' }
  | { name: 'certificates' }
  | { name: 'settings'; back: 'dashboard' | 'templates' };

const SCREEN_KEY = 'btx24:screen';
/** Экраны приложения, куда F5 возвращает (экраны встройки сделки — нет). */
const RESTORABLE = new Set(['calendar', 'dashboard', 'chats', 'alerts', 'templates', 'certificates', 'settings']);

/** Экран до перезагрузки страницы (sessionStorage вкладки; недоступен — дашборд). */
export function savedScreen(): AppScreen | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(SCREEN_KEY) ?? 'null') as AppScreen | null;
    if (!v || typeof v !== 'object' || !RESTORABLE.has(v.name)) return null;
    if (v.name === 'chats') return { name: 'chats', ...(Number.isSafeInteger(v.chatId) && v.chatId! > 0 ? { chatId: v.chatId } : {}), ...(v.waiting ? { waiting: true } : {}) };
    if (v.name === 'settings') return { name: 'settings', back: v.back === 'templates' ? 'templates' : 'dashboard' };
    if (v.name === 'alerts') return { name: 'alerts' };
    return { name: v.name } as AppScreen;
  } catch {
    return null;
  }
}

function saveScreen(screen: AppScreen): void {
  try {
    if (RESTORABLE.has(screen.name)) sessionStorage.setItem(SCREEN_KEY, JSON.stringify(screen));
  } catch {
    /* хранилище недоступно — после F5 просто дашборд */
  }
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
  // нет. Данные другой даты/группы не показываем; поздний ответ на старый ключ отбрасывается.
  const [resp, setResp] = useState<{ key: string; day: CalendarDay | null; error: string | null } | null>(null);
  const [selected, setSelected] = useState<CalendarBooking | null>(null);
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
  const [screen, setScreen] = useState<AppScreen>(() => {
    const alertId = new URLSearchParams(window.location.search).get('alert');
    if (alertId) return { name: 'alerts', alertId };
    // Открыли не из сделки — сначала дашборд (руководителю — свой), а после F5 — экран, где были;
    // из карточки сделки — «Чат · Сделка · Календарь».
    return placement.dealId ? { name: 'deal-home' } : (savedScreen() ?? { name: 'dashboard' });
  });
  // Приложение (не встройка): экран и открытый чат — в sessionStorage вкладки, F5 возвращает туда же.
  useEffect(() => {
    if (!placement.dealId) saveScreen(screen);
  }, [screen, placement.dealId]);
  const rememberChat = useCallback(
    (chatId: number | null) => {
      if (!placement.dealId && screen.name === 'chats') saveScreen({ ...screen, chatId: chatId ?? undefined });
    },
    [screen, placement.dealId],
  );
  // Встройка сделки → «Календарь»: по сделке уже есть бронь — предупреждение (новая сделка или игнорировать).
  const [dealWarning, setDealWarning] = useState(false);
  const [dealBookingsFailed, setDealBookingsFailed] = useState(false);
  const [creatingDeal, setCreatingDeal] = useState(false);
  const [newDealError, setNewDealError] = useState('');

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
  const day = resp?.key === query ? resp.day : null;
  // Пока нет ответа на выбранную дату/группу — прежний день под загрузчиком, без действий с ним.
  const shownDay = day ?? (loading ? (resp?.day ?? null) : null);
  const error = loading ? null : (resp?.error ?? null);

  useEffect(() => {
    if (groups === null || screen.name !== 'calendar') return;
    let cancelled = false;
    const stop = freshPoll(() => apiGet<CalendarDay>(`/calendar?${query}`).then(
      (d) => !cancelled && setResp({ key: query, day: d, error: null }),
      (e) =>
        !cancelled &&
        setResp((prev) => ({
          key: query,
          day: prev?.key === query ? prev.day : null,
          error: e instanceof ApiRequestError ? e.message : 'Не удалось загрузить календарь',
        })),
    ));
    // Прежний ответ помечаем устаревшим: он виден под загрузчиком до свежего ответа.
    return () => { cancelled = true; stop(); setResp((prev) => (prev ? { ...prev, key: '' } : null)); };
  }, [query, groups, dayRev, screen.name]);

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
      () => active && setDealBookingsFailed(true),
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

  const hasDay = day !== null;
  useEffect(() => fitFrame(), [hasDay, day?.bookings.length, view, selected?.id, screen.name]);

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

  // Бронь этой сделки, которая есть в модуле бронирования (известная только по полям сделки — снята/удалена).
  const dealBooking = placement.dealId
    ? [...(dealBookingsInfo?.upcoming ?? []), ...(dealBookingsInfo?.recent ?? [])].find((b) => b.dealId === placement.dealId && b.bookingId !== null) ?? null
    : null;
  const dealChecked = dealBookingsInfo !== null || dealBookingsFailed;
  // «Новая бронь» из встройки сделки — мастер брони поверх календаря.
  const startBooking = () => {
    if (screen.name !== 'deal-home') setScreen({ name: 'calendar' });
    setBookingForm({ date });
  };
  // Проверка закончилась, пока открыто окно, и брони нет — сразу мастер брони.
  if (dealWarning && dealChecked && !dealBooking) {
    setDealWarning(false);
    startBooking();
  }
  const createDeal = async () => {
    if (!placement.dealId) return;
    setCreatingDeal(true);
    setNewDealError('');
    try {
      const r = await apiPost<NewDealResultDto>(`/deals/${placement.dealId}/new-deal`, {});
      setDealWarning(false);
      openCrm('deal', r.id);
    } catch (e) {
      setNewDealError(e instanceof Error ? e.message : 'Не удалось создать сделку');
    } finally {
      setCreatingDeal(false);
    }
  };

  // Мастер брони и окно оплаты — и поверх календаря, и поверх встройки сделки.
  const overlays = (
    <>
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
          onOpenSettings={
            session.canManageApp
              ? () => {
                  setPayment(null);
                  setScreen({ name: 'settings', back: 'dashboard' });
                }
              : undefined
          }
        />
      )}
    </>
  );

  if (screen.name === 'deal-home' && placement.dealId)
    return (
      <>
        <DealHome
          dealId={placement.dealId}
          timezone={tz}
          groups={groups ?? []}
          dealInfo={dealBookingsInfo}
          timelinePending={(groups === null && !groupsError) || !dealChecked}
          canBook={session.canManageApp || permissions.has('booking.create')}
          canPay={session.canManageApp || permissions.has('payment.send')}
          onBooking={() => {
            if (dealChecked && !dealBooking) startBooking();
            else {
              setNewDealError('');
              setDealWarning(true);
            }
          }}
        />
        {dealWarning && (
          <DealBookingWarning
            booking={dealBooking ? `${fmtDateTime(dealBooking.start, tz)} — ${fmtDateTime(dealBooking.end, tz)}${dealBooking.resources.length ? ` · ${dealBooking.resources.join(', ')}` : ''}` : null}
            checking={!dealChecked}
            creating={creatingDeal}
            error={newDealError}
            canCreate={session.canManageApp || permissions.has('booking.create')}
            onCreate={() => void createDeal()}
            onIgnore={() => {
              setDealWarning(false);
              startBooking();
            }}
            onClose={() => !creatingDeal && setDealWarning(false)}
          />
        )}
        {overlays}
      </>
    );

  if (screen.name === 'deal' && placement.dealId) return <DealOverviewPage dealId={placement.dealId} timezone={tz} onBack={() => setScreen({ name: 'deal-home' })} />;

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

  if (screen.name === 'settings' && session.canManageApp)
    return (
      <SettingsPanel
        timezone={tz}
        temporary={session.settingsAccessUntil}
        onClose={() => setScreen(screen.back === 'templates' ? { name: 'templates' } : { name: 'dashboard' })}
        onChanged={() => setSettingsRevision((n) => n + 1)}
      />
    );

  if (screen.name === 'certificates') return <CertificatesPage timezone={tz} onBack={() => setScreen({ name: 'dashboard' })} />;

  if (screen.name === 'templates')
    return (
      <>
        <TemplatesPage
          admin={session.canManageApp}
          onBack={() => setScreen({ name: 'dashboard' })}
          onSettings={session.canManageApp ? () => setScreen({ name: 'settings', back: 'templates' }) : undefined}
        />
      </>
    );

  // Область снимков строится только после проверки групп и прав, без промежуточного пустого scope.
  if (screen.name === 'dashboard' && groups === null) return <div className="page"><p className="muted" role="status">Загрузка доступа…</p>{groupsError && <><p className="notice error">{groupsError}</p><button type="button" onClick={() => setSettingsRevision(n => n + 1)}>Повторить</button></>}</div>;

  // Настройки открываются только с дашборда (решение владельца): админам и по временному паролю.
  if (screen.name === 'dashboard')
    return (
      <>
        <DashboardSyncProvider scope={dashboardScope(session, groups)}>
        <DashboardPage
          session={session}
          openlines={openlinesRead}
          onBack={() => setScreen({ name: 'calendar' })}
          onChats={(o) => setScreen({ name: 'chats', ...o })}
          bookingAlerts={bookingsView}
          onAlerts={() => setScreen({ name: 'alerts' })}
          onSettings={() => setScreen({ name: 'settings', back: 'dashboard' })}
          onTemplates={openlinesSend ? () => setScreen({ name: 'templates' }) : undefined}
          onCertificates={() => setScreen({ name: 'certificates' })}
          groups={groups ?? []}
          onSession={(s) => {
            setSession(s);
            setSettingsRevision((n) => n + 1);
          }}
        />
        </DashboardSyncProvider>
      </>
    );
  if (screen.name === 'chats')
    return (
      <ChatsPage
        timezone={tz}
        canSend={openlinesSend}
        initialChatId={screen.chatId}
        initialWaiting={screen.waiting}
        period={screen.from && screen.to ? { from: screen.from, to: screen.to } : undefined}
        deal={screen.deal && placement.dealId ? { id: placement.dealId } : undefined}
        onOpenedChat={rememberChat}
        onClose={() => setScreen(screen.deal ? { name: 'deal-home' } : { name: 'dashboard' })}
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
          {placement.dealId && (
            <button className="deal-back" title="К встройке сделки: чат, шкала, быстрые действия" onClick={() => setScreen({ name: 'deal-home' })}>
              ‹ Сделка
            </button>
          )}
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

      <main className={`cal-main${loading ? ' loading' : ''}`} aria-busy={loading}>
        {shownDay && view === 'calendar' && (
          <DayGrid day={shownDay} highlightDealId={placement.dealId} onSelect={setSelected} onCreate={createAt} onStop={canStop ? setStopFor : undefined} />
        )}
        {shownDay && view === 'list' && (
          <DayList
            day={shownDay}
            groupName={activeGroup?.name ?? ''}
            highlightDealId={placement.dealId}
            onSelect={setSelected}
            onCreate={createAt}
          />
        )}
        {shownDay && view === 'availability' && (
          <DayAvailability
            day={shownDay}
            groupName={activeGroup?.name ?? ''}
            highlightDealId={placement.dealId}
            onSelect={setSelected}
            onCreate={createAt}
          />
        )}
        {!shownDay && loading && <div className="cal-loading-space" />}
        {loading && (
          <div className="cal-loader" role="status">
            <span className="cal-loader-box">
              <span className="spinner" aria-hidden="true" />
              Загрузка броней…
            </span>
          </div>
        )}
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
      {overlays}
    </div>
  );
}
