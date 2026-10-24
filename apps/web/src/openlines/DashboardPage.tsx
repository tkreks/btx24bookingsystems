import { BlockLoading } from '../dashboard/BlockLoading.js';
import { ColorLegend, type LegendItem } from '../ColorLegend.js';
import { AttentionMessage } from '../dashboard/AttentionMessage.js';
import { DashboardSyncStatus, useDashboardQuery } from '../dashboard/DashboardSync.js';
import { useEffect, useState, type ReactNode } from 'react';
import {
  todayIn,
  CALL_KINDS,
  CALL_KIND_LABELS,
  type AttentionChatDto,
  type BookingAlertListDto,
  type CallKind,
  type CallScope,
  type DashboardBookingRow,
  type DashboardDto,
  type DashboardNewDeal,
  type SessionInfo,
  allowedBlocks,
  type DashboardBlock,
  type DashboardBlockType,
  type DashboardLayoutDto,
  type HeadDashboardDto,
} from '@btx24/shared';
import { apiDelete, apiGet, apiPost, apiPut, logout } from '../api.js';
import { BlockGrid } from '../dashboard/BlockGrid.js';
import { OnShiftBlock } from '../dashboard/OnShiftBlock.js';
import { WorkdayControls } from '../workday/WorkdayControls.js';
import { MyActivityBlock } from '../dashboard/MyActivityBlock.js';
import { ActionLogBlock, AlertsBlock, CertificatesBlock, DealGapsBlock, NeedsCloseBlock, StopsBlock } from '../dashboard/control-blocks.js';
import { HEAD_BLOCKS, HeadBlock, versus, type HeadBlockType } from '../dashboard/head-blocks.js';
import { EmployeeActivity } from './EmployeeActivity.js';
import { isStandalone, openCrm, openPortalPath } from '../b24.js';
import { fmtAt, fmtDateTime, fmtMoney, fmtTime } from '../format.js';
import { Avatar } from './Avatar.js';
import { dayKey } from './chat-list.js';
import { TempAccessDialog } from '../settings/TempAccessDialog.js';
import { ThemeToggle } from '../theme/ThemeToggle.js';
import { CallLog } from './CallLog.js';
import { CallsModal } from './CallsModal.js';
import { DashBadge, RecentCalls } from './RecentCalls.js';
import { Icon } from './icons.js';
import { ListMore } from './ListMore.js';
import { DealStatusBadge } from './DealStatusBadge.js';
import { PERIOD_PRESETS, periodError, presetRange, type PeriodPreset } from './period.js';
import { MinimizeButton } from '../Minimize.js';

/** «23 октября 2026». */
const fmtDay = (date: string, tz: string) =>
  new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${date}T12:00:00Z`));

const CANCEL_REASON: Record<NonNullable<DashboardBookingRow['cancelReason']>, string> = {
  payment_timeout: 'не оплачена — снята системой',
  manual: 'снята сотрудником',
  removed_in_bitrix: 'удалена в Битрикс24',
};

/** «сегодня» / «вчера» / «за период» — подпись плиток по выбранному периоду. */
/** «Требуют внимания»: сколько чатов показывать сразу и сколько добавляет «Показать ещё». */
const ATTENTION_STEP = 5;
/** Выбор периода пока скрыт (владелец, 2026-10-24): дашборд — за текущий день; переключение остаётся в коде. */
const SHOW_PERIOD_PICKER = false;
const periodWord = (p: PeriodPreset) => (p === 'today' ? 'сегодня' : p === 'yesterday' ? 'вчера' : 'за период');

/**
 * Дашборд менеджера: в одном ряду — плитки (чаты ждут ответа, брони, звонки, новые сделки, повторные
 * клиенты); ниже две колонки блоков: сообщения клиентов без ответа и звонки периода | сделки за сегодня
 * и брони сегодня (по 5, «Показать ещё»); дальше — новые и удалённые брони. У каждого блока — иконка.
 */
export function DashboardPage({
  session,
  openlines,
  onBack,
  onChats,
  bookingAlerts = false,
  onAlerts,
  onSettings,
  onTemplates,
  onCertificates,
  onSession,
}: {
  session: SessionInfo;
  openlines: boolean;
  onBack: () => void;
  onChats: (opts: { chatId?: number; waiting?: boolean; from?: string; to?: string }) => void;
  /** Видны ли уведомления о бронях (право `booking.details`). */
  bookingAlerts?: boolean;
  onAlerts?: () => void;
  /** Открыть настройки (админам; остальным — после временного пароля). */
  onSettings?: () => void;
  /** Шаблоны сообщений: свои, общие и автоматические. */
  onTemplates?: () => void;
  /** Сертификаты: список, выпуск, изменение срока, погашение. */
  onCertificates?: () => void;
  onSession?: (s: SessionInfo) => void;
}) {
  const tz = session.portal.timezone;
  const [view, setView] = useState<'main' | 'calls'>('main');
  const [preset, setPreset] = useState<PeriodPreset>('today');
  const [range, setRange] = useState(() => presetRange('today', todayIn(tz)));
  const [draft, setDraft] = useState(range);
  // Части дашборда грузятся отдельно: основа — сразу, звонки и новые сделки — когда посчитаются.
  const alertsQuery = useDashboardQuery<BookingAlertListDto>(bookingAlerts ? '/booking-alerts?status=new' : null);
  const alertCount = alertsQuery.data?.counts.new;
  const [attentionShown, setAttentionShown] = useState(ATTENTION_STEP);
  const [hidden, setHidden] = useState<Set<number>>(() => new Set());
  const [hiding, setHiding] = useState<AttentionChatDto | null>(null);
  const [askCode, setAskCode] = useState(false);
  const [callsScope, setCallsScope] = useState<CallScope>('all');
  const [callsOpen, setCallsOpen] = useState<CallKind | null>(null);
  const [dealsOpen, setDealsOpen] = useState<'all' | 'repeat' | { source: string } | null>(null);
  const [daysOpen, setDaysOpen] = useState(false);
  // Воронка для «повторных»: пусто — сервер берёт первую воронку групп пользователя.
  const [callsFunnel, setCallsFunnel] = useState<number | null>(null);
  // Личный дашборд: раскладка (с сервера), режим настройки и черновик до «Готово».
  const [layout, setLayout] = useState<DashboardLayoutDto | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft2, setDraft2] = useState<DashboardBlock[]>([]);
  const [layoutError, setLayoutError] = useState('');
  useEffect(() => {
    apiGet<DashboardLayoutDto>('/dashboard/layout').then(setLayout, (e) => setLayoutError(e instanceof Error ? e.message : 'Не удалось загрузить раскладку'));
  }, []);
  const blocks = editing ? draft2 : (layout?.blocks ?? []);
  const saveLayout = (next: DashboardBlock[] | null) =>
    (next ? apiPut<DashboardLayoutDto>('/dashboard/layout', { blocks: next }) : apiDelete('/dashboard/layout').then(() => apiGet<DashboardLayoutDto>('/dashboard/layout'))).then(
      (l) => {
        setLayout(l);
        setEditing(false);
        setLayoutError('');
      },
      (e) => setLayoutError(e instanceof Error ? e.message : 'Не удалось сохранить дашборд'),
    );

  const query = `from=${range.from}&to=${range.to}&callsScope=${callsScope}${callsFunnel === null ? '' : `&callsFunnel=${callsFunnel}`}`;
  const paths = { base: `/dashboard?${query}&part=base`, calls: `/dashboard?${query}&part=calls`, deals: `/dashboard?${query}&part=deals`, chats: openlines ? '/dashboard/chat-attention' : null };
  const baseQuery = useDashboardQuery<Partial<DashboardDto>>(paths.base);
  const callsQuery = useDashboardQuery<Partial<DashboardDto>>(paths.calls);
  const dealsQuery = useDashboardQuery<Partial<DashboardDto>>(paths.deals);
  const chatQuery = useDashboardQuery<NonNullable<DashboardDto['chats']>>(paths.chats, undefined, 15_000);
  const error = baseQuery.error || callsQuery.error || dealsQuery.error;

  const choose = (p: PeriodPreset) => {
    setPreset(p);
    if (p !== 'custom') setRange(presetRange(p, todayIn(tz)));
    else setDraft(range);
  };
  const draftError = periodError(draft.from, draft.to);

  // Дашборд — из частей текущего запроса; нет основы — ещё грузится. Нет части — её плитки «…».
  const base = baseQuery.data;
  const d: Partial<DashboardDto> | null = base || callsQuery.data || dealsQuery.data ? { ...base, ...callsQuery.data, ...dealsQuery.data, ...(chatQuery.data ? { chats: chatQuery.data } : {}) } : null;
  const data = d;
  const funnels = data?.callFunnels ?? [];
  // null — недоступно (нет прав), undefined — ещё считается.
  const n = (v: number | null | undefined) => (v === undefined ? '…' : v === null ? '—' : String(v));
  const word = periodWord(preset);
  // Блоки «по дням и сравнение» — одним запросом за период дашборда, только если они есть на дашборде.
  const needHead = blocks.some((b) => (HEAD_BLOCKS as readonly string[]).includes(b.type));
  const headKey = needHead ? `${range.from}|${range.to}` : '';
  const headPath = headKey ? `/head-dashboard?from=${range.from}&to=${range.to}` : null;
  const headQuery = useDashboardQuery<HeadDashboardDto>(headPath);
  const head = headQuery.data;
  const periodText = range.from === range.to ? fmtDay(range.from, tz) : `${fmtDay(range.from, tz)} — ${fmtDay(range.to, tz)}`;
  // Скрытые с дашборда (👁) — сразу, не дожидаясь нового ответа сервера.
  const attention = (d?.chats?.attention ?? []).filter((c) => !hidden.has(c.chatId));
  const waiting = d?.chats?.waitingReply ?? 0;

  // Из каких запросов страницы блок берёт данные — для подписи «из кэша / обновлено» (свои запросы блоки отмечают сами).
  const sourcesOf = (type: DashboardBlockType): string[] => {
    const list =
      type === 'attention' ? [paths.chats]
      : type === 'bookingDays' || type === 'todayBookings' || type === 'newBookings' || type === 'removedBookings' ? [paths.base]
      : type === 'callsTotal' ? [paths.calls]
      : type === 'newDeals' || type === 'repeatClients' || type === 'deals' || type === 'dealSources' ? [paths.deals]
      : (HEAD_BLOCKS as readonly string[]).includes(type) ? [headPath]
      : [];
    return list.filter((x): x is string => !!x);
  };

  // Блоки личного дашборда: тип → содержимое (null — сотруднику блок недоступен).
  const renderBlock = (type: DashboardBlockType): ReactNode => {
    const loading = d ? '' : ' loading';
    switch (type) {
      case 'attention':
        return openlines ? (
          <section className="day-panel dash-block dash-attention">
            <DashBadge name="chats" />
            <p className="dash-attention-title muted">
              Последние сообщения клиентов без ответа
              {d?.chats && <span className={`pill${waiting ? ' waiting' : ''}`}>{waiting}</span>}
              {/* Все доступные чаты, без ограничения датой дашборда (бывший блок «Чатов ждут ответа»). */}
              <button type="button" className="link dash-open-chats" onClick={() => onChats({})}>
                Открыть чаты
              </button>
            </p>
            {!d && <BlockLoading />}
            {!d?.chats && <BlockLoading rows={4} />}
            {d?.chats && !attention.length && <p className="muted">Все клиенты получили ответ.</p>}
            <ul className="attention-rows">
              {attention.slice(0, attentionShown).map((c) => {
                return (
                  <li key={c.chatId} data-dashboard-anchor={`chat:${c.chatId}`}>
                    <AttentionMessage chat={c} timezone={tz} onOpen={() => onChats({ chatId: c.chatId })} />
                    <span className="attention-actions">
                      <button
                        className="dash-icon-btn"
                        title={c.dealId ? `Сделка #${c.dealId}` : 'Чат не привязан к сделке'}
                        aria-label="Открыть сделку"
                        disabled={!c.dealId}
                        onClick={() => c.dealId && openCrm('deal', c.dealId)}
                      >
                        <Icon name="handshake" size={18} />
                      </button>
                      <button className="dash-icon-btn" title="Перейти в чат" aria-label="Перейти в чат" onClick={() => onChats({ chatId: c.chatId })}>
                        <Icon name="chat" size={18} />
                      </button>
                      <button className="dash-icon-btn" title="Скрыть чат с дашборда" aria-label="Скрыть чат с дашборда" onClick={() => setHiding(c)}>
                        <Icon name="eye" size={18} />
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
            {!!d?.chats && <ListMore total={attention.length} shown={attentionShown} step={ATTENTION_STEP} onShow={setAttentionShown} />}
            {!!d?.chats && attentionShown >= attention.length && waiting > attention.length && (
              <button className="list-more" onClick={() => onChats({})}>
                Все ждущие ответа в чатах · {waiting}
              </button>
            )}
          </section>
        ) : null;
      case 'recentCalls':
        return <RecentCalls scope={callsScope} timezone={tz} from={range.from} to={range.to} onOpenChat={(chatId) => onChats({ chatId })} />;
      case 'deals':
        return <DealsCreated d={d} tz={tz} word={word} oneDay={range.from === range.to} />;
      case 'todayBookings':
        return <TodayBookings d={d} tz={tz} periodText={periodText} />;
      case 'dealSources':
        return d?.newDeals && d.newDeals.total > 0 ? (
          <DealSources items={d.newDeals.items} word={word} onOpen={(source) => setDealsOpen({ source })} />
        ) : (
          <section className="day-panel dash-sources">
            <p className="dash-attention-title muted">Источники новых сделок {word}</p>
            {d ? <p className="muted">Новых сделок нет.</p> : <BlockLoading rows={2} />}
          </section>
        );
      case 'newBookings':
        return <BookingList title="Новые бронирования" empty="Новых броней за период нет." list={d?.bookings?.created} tz={tz} variant="created" />;
      case 'removedBookings':
        return <BookingList title="Удалённые бронирования" empty="Удалённых броней за период нет." list={d?.bookings?.removed} tz={tz} variant="removed" />;
      case 'activity':
        return session.canManageApp ? <EmployeeActivity key={`${range.from}|${range.to}`} timezone={tz} startDate={range.from} endDate={range.to} /> : null;
      case 'noOpenline':
        return <DealGapsBlock period={range} kind="chat" tz={tz} />;
      case 'noContact':
        return <DealGapsBlock period={range} kind="contact" tz={tz} />;
      case 'onShift':
        return <OnShiftBlock timezone={tz} />;
      case 'myActivity':
        return <MyActivityBlock period={range} timezone={tz} onOpenChat={(chatId) => onChats({ chatId })} />;
      case 'actionLog':
        return session.canManageApp ? <ActionLogBlock tz={tz} period={range} /> : null;
      case 'needsClose':
        return <NeedsCloseBlock tz={tz} />;
      case 'alerts':
        return bookingAlerts ? <AlertsBlock period={range} onOpen={onAlerts} /> : null;
      case 'certificates':
        return <CertificatesBlock period={range} onOpen={onCertificates} />;
      case 'stops':
        return <StopsBlock period={range} />;
      default:
        return (HEAD_BLOCKS as readonly string[]).includes(type) ? (
          <HeadBlock type={type as HeadBlockType} d={head} vs={versus(preset, head, (x) => fmtDay(x, tz))} word={word} periodText={periodText} tz={tz} />
        ) : null;
    }
  };

  const periodBar = (
    <div className="period-bar">
      {SHOW_PERIOD_PICKER && (
        <div className="segmented period-presets" role="group" aria-label="Период">
          {PERIOD_PRESETS.map((p) => (
            <button key={p.key} className={preset === p.key ? 'active' : ''} onClick={() => choose(p.key)}>
              {p.label}
            </button>
          ))}
        </div>
      )}
      {SHOW_PERIOD_PICKER && preset === 'custom' && (
        <form
          className="period-custom"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draftError) setRange(draft);
          }}
        >
          <label>
            с <input type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
          </label>
          <label>
            по <input type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
          </label>
          <button className="primary" type="submit" disabled={!!draftError}>
            Показать
          </button>
          {draftError && <span className="muted">{draftError}</span>}
        </form>
      )}
      <div className="segmented period-presets dash-scope" role="group" aria-label="Чьи звонки и сделки">
        {(['all', 'mine'] as const).map((s) => (
          <button key={s} className={callsScope === s ? 'active' : ''} onClick={() => setCallsScope(s)}>
            {s === 'all' ? 'Все' : 'Мои'}
          </button>
        ))}
      </div>
    </div>
  );

  const errorBox = error && (
    <div className="notice error" role="alert">
      {error}
    </div>
  );

  if (view === 'calls')
    return (
      <div className="page dashboard">
      <DashboardSyncStatus />
        <header className="toolbar">
          <div className="toolbar-title">
            <button aria-label="К дашборду" onClick={() => setView('main')}>
              ‹
            </button>
            <h1>Звонки</h1>
            <span className="muted">клиенты {word}</span>
          </div>
          <div className="toolbar-controls">
            {funnels.length > 1 && (
              <label className="calls-funnel">
                Повторные по воронке{' '}
                <select value={callsFunnel ?? data?.callsFunnel ?? ''} onChange={(e) => setCallsFunnel(Number(e.target.value))}>
                  {funnels.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </header>
        {periodBar}
        {errorBox}
        {d && d.calls === null ? (
          <p className="notice">Статистика звонков недоступна: нет доступа к делам CRM.</p>
        ) : (
          <>
            <div className={`dash-row dash-row-6${d ? '' : ' loading'}`}>
              {CALL_KINDS.map((k) => (
                <button key={k} className={`dash-tile clickable${k === 'lost' && d?.calls?.lost ? ' warn' : ''}`} disabled={!d} onClick={() => setCallsOpen(k)}>
                  <span className="dash-tile-label">{CALL_KIND_LABELS[k]}</span>
                  <span className="dash-tile-value">{n(d?.calls?.[k])}</span>
                  <span className="dash-tile-link">Список →</span>
                </button>
              ))}
            </div>
            <p className="muted dash-note">
              Всего звонков {word}: <b>{n(d?.callsTotal)}</b> (входящие и исходящие). Плитки считают клиентов, а не звонки:
              несколько звонков от клиента и ему — один клиент. Повторный — есть состоявшаяся сделка в воронке{' '}
              {funnels.find((f) => f.id === d?.callsFunnel)?.name ?? 'группы'} до его первого звонка в периоде (не проиграна и бронь
              уже прошла; без брони — выигранная). Упущенный — после пропущенного нет успешного звонка и диалога с сотрудником в чате. Перезвон без ответа не снимает упущенного.
            </p>
          </>
        )}
        <CallLog key={`${range.from}|${range.to}`} scope={callsScope} timezone={tz} period={range} />
        {callsOpen && (
          <CallsModal
            kind={callsOpen}
            from={range.from}
            to={range.to}
            scope={callsScope}
            funnel={d?.callsFunnel ?? null}
            timezone={tz}
            onClose={() => setCallsOpen(null)}
          />
        )}
      </div>
    );

  return (
    <div className="page dashboard">
      <DashboardSyncStatus />
      <header className="toolbar">
        <div className="toolbar-title">
          <button className="dash-calendar-btn" aria-label="К календарю" title="Календарь броней" onClick={onBack}>
            <Icon name="calendar" size={20} />
          </button>
          <span className="muted toolbar-user">
            <Avatar src={session.user.photo} name={session.user.name} size={26} />
            {session.user.name}
          </span>
          <WorkdayControls timezone={tz} />
        </div>
        <div className="toolbar-controls">
          <ThemeToggle />
          {bookingAlerts && (
            <button className={`settings-button${alertCount ? ' has-badge' : ''}`} onClick={onAlerts} aria-label="Уведомления" title="Уведомления о бронях">
              <Icon name="bell" size={20} />
              {!!alertCount && <span className="badge">{alertCount}</span>}
            </button>
          )}
          {editing ? (
            <>
              <button className="settings-button primary" onClick={() => void saveLayout(draft2)} title="Сохранить свой дашборд">
                ✓ Готово
              </button>
              <button className="settings-button" onClick={() => confirm('Вернуть дашборд по умолчанию?') && void saveLayout(null)} title="Раскладка по умолчанию">
                Сбросить
              </button>
              <button className="settings-button" onClick={() => setEditing(false)}>
                Отмена
              </button>
            </>
          ) : (
            <button
              className="settings-button"
              disabled={!layout}
              onClick={() => {
                setDraft2(layout?.blocks ?? []);
                setEditing(true);
              }}
              aria-label="Настроить"
              title="Настроить дашборд: блоки, порядок, ширина"
            >
              <Icon name="layout" size={20} />
            </button>
          )}
          {onTemplates && (
            <button className="settings-button" onClick={onTemplates} aria-label="Шаблоны" title="Шаблоны сообщений: свои, общие и автоматические">
              <Icon name="mail" size={20} />
            </button>
          )}
          {onCertificates && (
            <button className="settings-button" onClick={onCertificates} aria-label="Сертификаты" title="Сертификаты: выпуск, изменение срока, погашение">
              <Icon name="certificate" size={20} />
            </button>
          )}
          {onSettings && (
            <button
              className="settings-button"
              onClick={() => (session.canManageApp ? onSettings() : setAskCode(true))}
              aria-label="Настройки"
              title={session.canManageApp ? 'Настройки приложения' : 'Настройки — для администраторов или по временному паролю'}
            >
              <Icon name="settings" size={20} />
            </button>
          )}
          {/* Вне портала (вход через Битрикс24) — выход из сессии приложения. */}
          {isStandalone() && (
            <button className="settings-button" onClick={() => void logout()} aria-label="Выйти" title={`Выйти: ${session.user.name}`}>
              <Icon name="logout" size={20} />
            </button>
          )}
        </div>
      </header>
      {askCode && (
        <TempAccessDialog
          onClose={() => setAskCode(false)}
          onGranted={(s) => {
            setAskCode(false);
            onSession?.(s);
            onSettings?.();
          }}
        />
      )}

      {hiding && (
        <HideChatDialog
          chat={hiding}
          onClose={() => setHiding(null)}
          onHidden={(id) => {
            setHidden((h) => new Set(h).add(id));
            setHiding(null);
          }}
        />
      )}

      {periodBar}
      {errorBox}
      {layoutError && <div className="notice error">{layoutError}</div>}
      {editing && (
        <p className="notice dash-edit-note">
          Настройка дашборда: перетаскивайте блоки или двигайте стрелками, выбирайте ширину (¼ ⅓ ½ ▭), убирайте лишнее и добавляйте
          новые. «Готово» — сохранить (дашборд только ваш).
        </p>
      )}

      <BlockGrid
        blocks={blocks}
        editing={editing}
        available={allowedBlocks(session.canManageApp)}
        onChange={setDraft2}
        render={(b) => renderBlock(b.type)}
        sources={(b) => sourcesOf(b.type)}
      />
      {d && d.newDeals === null && <p className="muted dash-note">Новые сделки недоступны: нет доступа к сделкам CRM.</p>}
      <p className="muted dash-note">
        Новые сделки — созданные {word} в воронках ваших групп; повторный клиент — у контакта уже была состоявшаяся сделка той же
        воронки. Брони — все на ресурсах ваших групп: созданные в приложении и в самом Битрикс24; удалённые остаются в истории
        приложения. Блоки «по дням и сравнение» — по воронкам всех групп, с прошлым периодом той же длины.
      </p>
      {daysOpen && d?.bookingDays && <DayBookingsModal days={d.bookingDays} tz={tz} onClose={() => setDaysOpen(false)} />}
      {dealsOpen && d?.newDeals && (
        <NewDealsModal
          title={
            dealsOpen === 'repeat' ? 'Повторные клиенты' : dealsOpen === 'all' ? `Новые сделки ${word}` : `Источник «${sourceLabel(d.newDeals.items, dealsOpen.source)}»`
          }
          items={
            dealsOpen === 'repeat'
              ? d.newDeals.items.filter((i) => i.repeat)
              : dealsOpen === 'all'
                ? d.newDeals.items
                : d.newDeals.items.filter((i) => (i.source?.id ?? '') === dealsOpen.source)
          }
          truncated={d.newDeals.truncated}
          tz={tz}
          onClose={() => setDealsOpen(null)}
        />
      )}
    </div>
  );
}

/** Окно со списком новых сделок (или только повторных клиентов). */
function NewDealsModal({
  title,
  items,
  truncated,
  tz,
  onClose,
}: {
  title: string;
  items: DashboardNewDeal[];
  truncated: boolean;
  tz: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet calls-modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>
            {title} <span className="muted">· {items.length}</span>
          </h3>
          <MinimizeButton label="Сделки" />
          <button aria-label="Закрыть" onClick={onClose}>
            ×
          </button>
        </header>
        {truncated && <p className="notice">Сделок очень много — показаны последние. Сузьте период.</p>}
        <ul className="call-rows">
          {items.map((i) => (
            <li key={i.id}>
              <button className="link call-client" onClick={() => openCrm('deal', i.id)}>
                {i.title}
              </button>
              {i.contact ? (
                <button className="link" onClick={() => openCrm('contact', i.contact!.id)}>
                  {i.contact.name ?? `Контакт #${i.contact.id}`}
                </button>
              ) : (
                <span className="muted">без контакта</span>
              )}
              <span className={`pill${i.repeat ? '' : ' muted-pill'}`}>{i.repeat ? 'повторный' : 'новый'}</span>
              <BookingMark state={i.booking} certificate={i.certificate} />
              <DealStatusBadge s={i.status} />
              <span className="muted">
                создана {fmtDateTime(i.createdAt, tz)}
                {i.opportunity ? ` · ${fmtMoney(i.opportunity, i.currency)}` : ''}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** «23.10, 14:00–16:00»; на несколько дней — «23.10, 14:00 – 25.10, 12:00». */
function bookingRange(start: string, end: string, tz: string): string {
  return dayKey(start, tz) === dayKey(end, tz)
    ? `${fmtDateTime(start, tz)}–${fmtTime(end, tz)}`
    : `${fmtDateTime(start, tz)} – ${fmtDateTime(end, tz)}`;
}

function BookingList({
  title,
  empty,
  list,
  tz,
  variant,
}: {
  title: string;
  empty: string;
  list: { total: number; items: DashboardBookingRow[] } | undefined;
  tz: string;
  variant: 'created' | 'removed';
}) {
  const openDeal = (id: number) => openPortalPath(`/crm/deal/details/${id}/`);
  const rows = list?.items;
  return (
    <section className="day-panel dash-list">
      <div className="day-header">
        <b>{title}</b>
        {list && <span className="pill">{list.total}</span>}
      </div>
      {!rows && <BlockLoading />}
      {rows && !rows.length && <p className="muted">{empty}</p>}
      <ul className="booking-rows">
        {rows?.map((r) => (
          <li key={r.bookingId} className="booking-row">
            <div className="booking-row-main">
              {r.dealId ? (
                <button className="link" onClick={() => openDeal(r.dealId!)}>
                  {r.deal?.title || r.title || `Сделка #${r.dealId}`}
                </button>
              ) : (
                <span>{r.title || 'Служебная бронь'}</span>
              )}
              {r.deal && <span className="muted">{fmtMoney(r.deal.opportunity, r.deal.currency)}</span>}
              <DealStatusBadge s={r.deal?.status} />
            </div>
            <div className="booking-row-meta">
              <span>{bookingRange(r.start, r.end, tz)}</span>
              <span className="muted">{r.resources.join(', ')}</span>
            </div>
            <div className="booking-row-tags">
              {r.source === 'bitrix' && <span className="pill muted-pill">из Битрикс24</span>}
              {variant === 'removed' ? (
                r.pendingRemoval ? (
                  <span className="pill waiting">пропала в Битрикс24 — ждёт решения</span>
                ) : (
                  <>
                    {r.cancelReason && <span className={`pill${r.cancelReason === 'payment_timeout' ? ' waiting' : ' muted-pill'}`}>{CANCEL_REASON[r.cancelReason]}</span>}
                    <span className="muted">
                      {r.cancelledAt && `удалена ${fmtDateTime(r.cancelledAt, tz)}`}
                      {r.cancelledBy && ` · ${r.cancelledBy}`}
                    </span>
                  </>
                )
              ) : (
                <>
                  {r.status === 'cancelled' && <span className="pill muted-pill">уже удалена</span>}
                  {r.status === 'active' && r.pendingRemoval && <span className="pill waiting">удалена в Битрикс24 — ждёт решения</span>}
                  <span className="muted">
                    {r.source === 'bitrix' ? 'найдена' : 'создана'} {fmtDateTime(r.createdAt, tz)}
                    {r.createdBy && ` · ${r.createdBy}`}
                  </span>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Бронь по сделке: 🪙 — есть и оплачена, 📅 — есть, не оплачена, 🎟 — покупка сертификата, иначе — «без брони». */
function BookingMark({ state, certificate = false }: { state: DashboardNewDeal['booking']; certificate?: boolean }) {
  if (certificate)
    return (
      <span className="deal-mark cert" title="Покупка сертификата: брони нет, оплаченная — успешная сделка" aria-label="Сертификат">
        🎟 сертификат
      </span>
    );
  if (state === 'paid')
    return (
      <span className="deal-mark paid" title="Есть бронь, оплачена" aria-label="Бронь оплачена">
        🪙
      </span>
    );
  if (state === 'booked')
    return (
      <span className="deal-mark booked" title="Есть бронь, ещё не оплачена" aria-label="Есть бронь">
        📅
      </span>
    );
  return <span className="deal-mark none">без брони</span>;
}

/** Списки дашборда: сразу — 5 строк, «Показать ещё» добавляет по 5. */
const LIST_STEP = 5;

/** Бронь относительно «сейчас»: прошла (голубая), идёт (зелёная), ещё впереди (жёлтая). */
function slotState(start: string, end: string, now = Date.now()): 'past' | 'now' | 'soon' {
  if (Date.parse(end) <= now) return 'past';
  return Date.parse(start) <= now ? 'now' : 'soon';
}
const SLOT_LABEL = { past: 'прошла', now: 'идёт сейчас', soon: 'впереди' } as const;
/** Легенда цветов броней (карточки и время брони у сделок). */
const SLOT_LEGEND: LegendItem[] = [
  { label: 'прошла', swatch: { borderColor: '#b9e6fe', background: '#e0f2fe' } },
  { label: 'идёт сейчас', swatch: { borderColor: '#a6e9c3', background: '#dcfae6' } },
  { label: 'впереди', swatch: { borderColor: '#fedf89', background: '#fef0c7' } },
];

/** Время брони: сегодняшняя — «14:00–16:00», иначе — с датами. */
function slotText(start: string, end: string, tz: string): string {
  const today = todayIn(tz);
  return dayKey(start, tz) === today && dayKey(end, tz) === today ? `${fmtTime(start, tz)}–${fmtTime(end, tz)}` : bookingRange(start, end, tz);
}

/**
 * «Брони сегодня»: сделки с бронью на сегодня, по 5. В строке — сумма сделки, сделка и клиент, ресурс,
 * время; цвет — прошла (голубая), идёт (зелёная), впереди (жёлтая).
 */
function TodayBookings({ d, tz, periodText }: { d: Partial<DashboardDto> | null; tz: string; periodText: string }) {
  const [shown, setShown] = useState(LIST_STEP);
  const booked = [...new Map((d?.bookingDays?.todayItems ?? []).filter((r) => r.dealId).map((r) => [r.dealId!, r])).values()];
  return (
    <section className="day-panel dash-block dash-today-bookings">
      <DashBadge name="calendar" />
      <p className="dash-attention-title muted">
        Брони · {periodText}
        {d?.bookingDays && <span className="pill">{booked.length}</span>}
      </p>
      <ColorLegend items={SLOT_LEGEND} label="Цвета броней" className="block" />
      {!d?.bookingDays && <BlockLoading rows={4} />}
      <ul className="dt-rows booking-card-grid">
        {booked.slice(0, shown).map((r) => {
          const state = slotState(r.start, r.end);
          return (
            <li key={`b${r.bookingId}`}>
              <button
                className={`dt-row dash-record slot-${state}${r.pendingRemoval ? ' today missing' : ''}`}
                title={r.pendingRemoval ? 'Удалена в Битрикс24 — ждёт решения' : `Бронь ${SLOT_LABEL[state]}`}
                onClick={() => openCrm('deal', r.dealId!)}
              >
                <span className="booking-card-head"><b>{r.resources.join(', ') || 'Ресурс не указан'}</b><DealStatusBadge s={r.deal?.status} /></span>
                <span className="booking-card-time"><Icon name="clock" size={15} />{slotText(r.start, r.end, tz)}</span>
                <span className="booking-card-client"><Icon name="person" size={15} />{r.deal?.client || 'Без клиента'}</span>
                <span className="booking-card-foot"><span className="dash-record-link" title={r.deal?.title || r.title || undefined}>Сделка #{r.dealId}</span><b>{r.deal ? fmtMoney(r.deal.opportunity ?? 0, r.deal.currency) : '—'}</b></span>
                {r.pendingRemoval && <span className="dash-record-details error">Удалена в Битрикс24 — ждёт решения</span>}
              </button>
            </li>
          );
        })}
        {d?.bookingDays && !booked.length && <li className="muted dt-empty">Броней за выбранный период нет.</li>}
      </ul>
      <ListMore total={booked.length} shown={shown} step={LIST_STEP} onShow={setShown} />
    </section>
  );
}

/**
 * «Сделки за сегодня» (или за период): созданные сделки, по 5. В строке — сумма, сделка и клиент,
 * ресурс и время брони (цвет брони — как в «Бронях сегодня»); оплаченные — зелёные, с 🪙. Вкладка
 * «С оплатой» — только сделки с оплатой в периоде (счета «Оплачен» по времени перевода), справа — оплата.
 */
function DealsCreated({ d, tz, word, oneDay }: { d: Partial<DashboardDto> | null; tz: string; word: string; oneDay: boolean }) {
  const [shown, setShown] = useState(LIST_STEP);
  // «Созданные за период» / «с оплатой за период» (поступила оплата — любая дата создания).
  const [mode, setMode] = useState<'created' | 'paid'>('created');
  const paidMode = mode === 'paid';
  const created = (paidMode ? d?.paidDeals?.items : d?.newDeals?.items) ?? [];
  const when = word === 'сегодня' ? 'за сегодня' : word;
  const paidWhen = word === 'сегодня' ? 'с оплатой сегодня' : word === 'вчера' ? 'с оплатой вчера' : 'с оплатой за период';
  const switchTo = (m: 'created' | 'paid') => {
    setMode(m);
    setShown(LIST_STEP);
  };
  return (
    <section className="day-panel dash-block dash-deals-created">
      <DashBadge name="handshake" />
      <p className="dash-attention-title muted">
        Сделки
        {d?.newDeals && (
          <span className="pill" title={`Создано ${when} / ${paidWhen}`}>
            {d.newDeals.total}/{d.paidDeals?.total ?? 0}
          </span>
        )}
      </p>
      <div className="segmented dt-switch" role="group" aria-label="Какие сделки">
        <button className={paidMode ? '' : 'active'} aria-pressed={!paidMode} onClick={() => switchTo('created')}>
          {when[0].toUpperCase() + when.slice(1)} · {d?.newDeals?.total ?? '…'}
        </button>
        <button className={paidMode ? 'active' : ''} aria-pressed={paidMode} onClick={() => switchTo('paid')}>
          🪙 {paidWhen[0].toUpperCase() + paidWhen.slice(1)} · {d?.paidDeals === undefined ? '…' : (d.paidDeals?.total ?? '—')}
        </button>
      </div>
      {created.some((i) => i.slot) && <ColorLegend items={SLOT_LEGEND} label="Цвета времени брони" className="block" />}
      {paidMode && (
        <p className="muted dt-hint">
          Только сделки, по которым {word === 'за период' ? 'за период' : word} поступила оплата: счёт переведён в «Оплачен» или внесена сумма. Справа — когда и
          сколько оплачено; ресурс и время брони — ниже.
        </p>
      )}
      {(!d || d.newDeals === undefined) && <BlockLoading rows={4} />}
      {d?.newDeals === null && <p className="muted">Нет доступа к сделкам CRM.</p>}
      <ul className="dt-rows">
        {created.slice(0, shown).map((i) => {
          const state = i.slot ? slotState(i.slot.start, i.slot.end) : null;
          return (
            <li key={`n${i.id}`}>
              <button className={`dt-row dash-record${i.paid ? ' paid' : ''}`} title={i.paid ? 'Сделка оплачена' : undefined} onClick={() => openCrm('deal', i.id)}>
                <b className="dash-record-main" title={i.title}>{i.title}</b>
                <span className="dash-record-value">
                  {paidMode && i.payment ? <>Оплачено {fmtMoney(i.payment.amount, i.currency)}</> : fmtMoney(i.opportunity ?? 0, i.currency)}
                </span>
                <span className="dash-record-details"><span>{i.contact?.name || 'Без контакта'}</span><DealStatusBadge s={i.status} /></span>
                <span className="dash-record-details">
                  {i.slot && state ? <><span>{i.slot.resources.join(', ')}</span><span className={`slot-chip ${state}`}>{slotText(i.slot.start, i.slot.end, tz)}</span></> : <BookingMark state={i.booking} certificate={i.certificate} />}
                </span>
                <span className="dash-record-meta">
                  <span>Создана {fmtAt(i.createdAt, tz, oneDay)}</span>
                  {i.source && <span>{i.source.name}</span>}
                  {i.repeat && <span>Повторный клиент</span>}
                  {paidMode && i.payment && <><span>Оплата {fmtAt(i.payment.at, tz, oneDay)}</span><span>Сумма сделки {fmtMoney(i.opportunity ?? 0, i.currency)}</span></>}
                </span>
              </button>
            </li>
          );
        })}
        {d?.newDeals && !created.length && <li className="muted dt-empty">{paidMode ? `Оплат ${word === 'за период' ? 'за период' : word} нет.` : 'Новых сделок нет.'}</li>}
      </ul>
      <ListMore total={created.length} shown={shown} step={LIST_STEP} onShow={setShown} />
    </section>
  );
}

/** 👁: скрыть чат с дашборда этого сотрудника — после подтверждения. */
function HideChatDialog({ chat, onClose, onHidden }: { chat: AttentionChatDto; onClose: () => void; onHidden: (chatId: number) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  const hide = () => {
    setBusy(true);
    apiPost(`/dashboard/hidden-chats/${chat.chatId}`).then(
      () => onHidden(chat.chatId),
      (e) => {
        setBusy(false);
        setError(e instanceof Error ? e.message : 'Не удалось скрыть чат');
      },
    );
  };
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet hide-chat-modal" role="dialog" aria-modal="true" aria-label="Скрыть чат с дашборда" onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>Скрыть чат с дашборда?</h3>
          <MinimizeButton label="Скрыть чат" />
          <button aria-label="Закрыть" onClick={onClose}>
            ×
          </button>
        </header>
        <p>
          Подтвердите, что хотите скрыть чат <b>{chat.clientName || chat.title}</b> с дашборда. Чат останется в списке чатов и при
          новых сообщениях будет подниматься выше, но на вашем дашборде показываться больше не будет.
        </p>
        {error && <p className="notice error">{error}</p>}
        <div className="form-actions">
          <button className="primary" disabled={busy} onClick={hide}>
            Скрыть
          </button>
          <button onClick={onClose}>Отмена</button>
        </div>
      </div>
    </div>
  );
}

/** «Календарь» на плитке броней: сделки с бронями на сегодня и на завтра. */
function DayBookingsModal({ days, tz, onClose }: { days: DashboardDto['bookingDays']; tz: string; onClose: () => void }) {
  const [tab, setTab] = useState<'today' | 'tomorrow'>(days.today || !days.tomorrow ? 'today' : 'tomorrow');
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  const rows = tab === 'today' ? days.todayItems : days.tomorrowItems;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet calls-modal" role="dialog" aria-modal="true" aria-label="Брони выбранного периода и следующего дня" onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>Брони</h3>
          <MinimizeButton label="Брони" />
          <button aria-label="Закрыть" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="wz-seg dbm-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'today'} className={tab === 'today' ? 'active' : ''} onClick={() => setTab('today')}>
            {days.from === days.to ? days.from : `${days.from} — ${days.to}`} · {days.today}
          </button>
          <button role="tab" aria-selected={tab === 'tomorrow'} className={tab === 'tomorrow' ? 'active' : ''} onClick={() => setTab('tomorrow')}>
            {days.nextDate ?? 'Следующий день'} · {days.tomorrow}
          </button>
        </div>
        {!rows.length && <p className="muted">Броней нет.</p>}
        <ul className="dt-rows">
          {rows.map((r) => (
            <li key={r.bookingId}>
              <button className={`dt-row${r.pendingRemoval ? ' today missing' : ''}`} disabled={!r.dealId} onClick={() => r.dealId && openCrm('deal', r.dealId)}>
                <span className="dt-main">
                  <span className="dt-title">
                    <b>{r.dealId ? r.deal?.title || r.title || `Сделка #${r.dealId}` : r.title || 'Служебная бронь'}</b>
                    <DealStatusBadge s={r.deal?.status} />
                  </span>
                  <span className="muted">
                    {[r.deal?.client, r.resources.join(', '), r.pendingRemoval ? 'удалена в Битрикс24 — ждёт решения' : ''].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span className="dt-side">
                  <span>{bookingRange(r.start, r.end, tz)}</span>
                  {r.deal?.opportunity ? <span className="muted">{fmtMoney(r.deal.opportunity, r.deal.currency)}</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const NO_SOURCE = 'Без источника';
const sourceLabel = (items: DashboardNewDeal[], id: string) => items.find((i) => (i.source?.id ?? '') === id)?.source?.name ?? NO_SOURCE;
const SOURCE_COLORS = ['#3269f6', '#16a34a', '#f59e0b', '#db2777', '#7c3aed', '#0891b2', '#ea580c', '#64748b'];

/** Источники новых сделок за период: полосы по числу сделок; клик — список сделок источника. */
function DealSources({ items, word, onOpen }: { items: DashboardNewDeal[]; word: string; onOpen: (source: string) => void }) {
  const groups = [...items.reduce((m, i) => m.set(i.source?.id ?? '', [...(m.get(i.source?.id ?? '') ?? []), i]), new Map<string, DashboardNewDeal[]>())]
    .map(([id, list]) => ({ id, name: list[0].source?.name ?? NO_SOURCE, count: list.length, paid: list.filter((i) => i.booking === 'paid').length }))
    .sort((a, b) => b.count - a.count);
  const max = groups[0]?.count ?? 1;
  return (
    <section className="day-panel dash-block dash-sources">
      <DashBadge name="handshake" />
      <p className="dash-attention-title muted">Источники новых сделок {word}</p>
      {!!items.length && <svg className="source-donut" viewBox="0 0 100 100" role="img" aria-label="Диаграмма источников новых сделок">
        {groups.map((g, i) => {
          const share = g.count / items.length * 100;
          const before = groups.slice(0, i).reduce((n, row) => n + row.count, 0) / items.length * 100;
          return <circle key={g.id || '-'} cx="50" cy="50" r="38" pathLength="100" fill="none" stroke={SOURCE_COLORS[i % SOURCE_COLORS.length]} strokeWidth="18" strokeDasharray={`${share} ${100 - share}`} strokeDashoffset={-before} transform="rotate(-90 50 50)"><title>{g.name}: {g.count} · {Math.round(share)}%</title></circle>;
        })}
        <text x="50" y="49" textAnchor="middle" dominantBaseline="middle" className="source-donut-total">{items.length}</text>
        <text x="50" y="62" textAnchor="middle" className="source-donut-label">сделок</text>
      </svg>}
      <ul className="src-rows">
        {groups.map((g, i) => (
          <li key={g.id || '-'}>
            <button className="src-row" onClick={() => onOpen(g.id)} title="Показать сделки источника">
              <span className="src-name">{g.name}</span>
              <span className="src-bar">
                <i style={{ width: `${(g.count / max) * 100}%`, background: SOURCE_COLORS[i % SOURCE_COLORS.length] }} />
              </span>
              <span className="src-count">
                <b>{g.count}</b>
                <span className="muted"> · {Math.round((g.count / items.length) * 100)}%</span>
                {g.paid > 0 && <span className="muted"> · 🪙 {g.paid}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
