import { useEffect, useState } from 'react';
import {
  todayIn,
  CALL_KINDS,
  CALL_KIND_LABELS,
  type BookingAlertListDto,
  type CallKind,
  type CallScope,
  type DashboardBookingRow,
  DASHBOARD_PARTS,
  type DashboardDto,
  type DashboardPart,
  type DashboardNewDeal,
  type SessionInfo,
} from '@btx24/shared';
import { apiGet, logout } from '../api.js';
import { isStandalone, openCrm, openPortalPath } from '../b24.js';
import { fmtDateTime, fmtMoney, fmtTime } from '../format.js';
import { dayKey } from './chat-list.js';
import { TempAccessDialog } from '../settings/TempAccessDialog.js';
import { WorkdayButton } from '../workday/WorkdayButton.js';
import { CallLog } from './CallLog.js';
import { Channel } from './Channel.js';
import { CallsModal } from './CallsModal.js';
import { EmployeeActivity } from './EmployeeActivity.js';
import { DashBadge, RecentCalls } from './RecentCalls.js';
import { Icon } from './icons.js';
import { PERIOD_PRESETS, periodError, presetRange, type PeriodPreset } from './period.js';

const CANCEL_REASON: Record<NonNullable<DashboardBookingRow['cancelReason']>, string> = {
  payment_timeout: 'не оплачена — снята системой',
  manual: 'снята сотрудником',
  removed_in_bitrix: 'удалена в Битрикс24',
};

/** «сегодня» / «вчера» / «за период» — подпись плиток по выбранному периоду. */
/** «Требуют внимания»: сколько чатов показывать сразу и сколько добавляет «Ещё». */
const ATTENTION_STEP = 5;
const periodWord = (p: PeriodPreset) => (p === 'today' ? 'сегодня' : p === 'yesterday' ? 'вчера' : 'за период');

/**
 * Дашборд менеджера: в одном ряду — плитки (чаты ждут ответа, брони, звонки, новые сделки, повторные
 * клиенты); ниже две колонки блоков: сообщения клиентов без ответа и последние звонки | брони сегодня
 * и сделки за сегодня (по 5, «Ещё»); дальше — новые и удалённые брони. У каждого блока — иконка.
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
  onSession,
}: {
  session: SessionInfo;
  openlines: boolean;
  onBack: () => void;
  onChats: (opts: { chatId?: number; waiting?: boolean }) => void;
  /** Видны ли уведомления о бронях (право `booking.details`). */
  bookingAlerts?: boolean;
  onAlerts?: () => void;
  /** Открыть настройки (админам; остальным — после временного пароля). */
  onSettings?: () => void;
  /** Шаблоны сообщений: свои, общие и автоматические. */
  onTemplates?: () => void;
  onSession?: (s: SessionInfo) => void;
}) {
  const tz = session.portal.timezone;
  const [view, setView] = useState<'main' | 'calls'>('main');
  const [preset, setPreset] = useState<PeriodPreset>('today');
  const [range, setRange] = useState(() => presetRange('today', todayIn(tz)));
  const [draft, setDraft] = useState(range);
  // Части дашборда грузятся отдельно: основа — сразу, звонки и новые сделки — когда посчитаются.
  const [parts, setParts] = useState<Partial<Record<DashboardPart, { key: string; dto: Partial<DashboardDto> }>>>({});
  const [error, setError] = useState('');
  const [alertCount, setAlertCount] = useState<number | null>(null);
  const [attentionShown, setAttentionShown] = useState(ATTENTION_STEP);
  const [askCode, setAskCode] = useState(false);
  const [callsScope, setCallsScope] = useState<CallScope>('all');
  const [callsOpen, setCallsOpen] = useState<CallKind | null>(null);
  const [dealsOpen, setDealsOpen] = useState<'all' | 'repeat' | { source: string } | null>(null);
  const [daysOpen, setDaysOpen] = useState(false);
  // Воронка для «повторных»: пусто — сервер берёт первую воронку групп пользователя.
  const [callsFunnel, setCallsFunnel] = useState<number | null>(null);

  useEffect(() => {
    if (!bookingAlerts) return;
    let active = true;
    apiGet<BookingAlertListDto>('/booking-alerts?status=new').then(
      (l) => active && setAlertCount(l.counts.new),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [bookingAlerts]);

  const query = `from=${range.from}&to=${range.to}&callsScope=${callsScope}${callsFunnel === null ? '' : `&callsFunnel=${callsFunnel}`}`;
  useEffect(() => {
    let active = true;
    for (const part of DASHBOARD_PARTS)
      apiGet<Partial<DashboardDto>>(`/dashboard?${query}&part=${part}`).then(
        (dto) => {
          if (!active) return;
          setParts((prev) => ({ ...prev, [part]: { key: query, dto } }));
          setError('');
        },
        (e) => active && setError(e instanceof Error ? e.message : 'Не удалось загрузить дашборд'),
      );
    return () => {
      active = false;
    };
  }, [query]);

  const choose = (p: PeriodPreset) => {
    setPreset(p);
    if (p !== 'custom') setRange(presetRange(p, todayIn(tz)));
    else setDraft(range);
  };
  const draftError = periodError(draft.from, draft.to);

  // Дашборд — из частей текущего запроса; нет основы — ещё грузится. Нет части — её плитки «…».
  const fresh = (p: DashboardPart) => (parts[p]?.key === query ? parts[p]!.dto : undefined);
  const base = fresh('base');
  const d: Partial<DashboardDto> | null = base ? { ...base, ...fresh('calls'), ...fresh('deals') } : null;
  const data = d ?? parts.base?.dto ?? null;
  const funnels = data?.callFunnels ?? [];
  // null — недоступно (нет прав), undefined — ещё считается.
  const n = (v: number | null | undefined) => (v === undefined ? '…' : v === null ? '—' : String(v));
  const word = periodWord(preset);

  const periodBar = (
    <div className="period-bar">
      <div className="segmented period-presets" role="group" aria-label="Период">
        {PERIOD_PRESETS.map((p) => (
          <button key={p.key} className={preset === p.key ? 'active' : ''} onClick={() => choose(p.key)}>
            {p.label}
          </button>
        ))}
      </div>
      {preset === 'custom' && (
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
              уже прошла; без брони — выигранная). Упущенный — после пропущенного не перезвонили и он сам не дозвонился.
            </p>
          </>
        )}
        <CallLog scope={callsScope} timezone={tz} />
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
      <header className="toolbar">
        <div className="toolbar-title">
          <button className="dash-calendar-btn" aria-label="К календарю" title="Календарь броней" onClick={onBack}>
            <Icon name="calendar" size={20} />
          </button>
          <h1>Мой дашборд</h1>
          <span className="muted">{session.user.name}</span>
        </div>
        <div className="toolbar-controls">
          <WorkdayButton timezone={tz} />
          {bookingAlerts && (
            <button className={`settings-button${alertCount ? ' has-badge' : ''}`} onClick={onAlerts} title="Уведомления о бронях">
              <span aria-hidden="true">🔔</span> Уведомления
              {!!alertCount && <span className="badge">{alertCount}</span>}
            </button>
          )}
          {onTemplates && (
            <button className="settings-button" onClick={onTemplates} title="Шаблоны сообщений: свои, общие и автоматические">
              <span aria-hidden="true">✉</span> Шаблоны
            </button>
          )}
          {onSettings && (
            <button
              className="settings-button"
              onClick={() => (session.canManageApp ? onSettings() : setAskCode(true))}
              title={session.canManageApp ? 'Настройки приложения' : 'Настройки — для администраторов или по временному паролю'}
            >
              <span aria-hidden="true">⚙</span> Настройки
            </button>
          )}
          {/* Вне портала (вход через Битрикс24) — выход из сессии приложения. */}
          {isStandalone() && (
            <button className="settings-button" onClick={() => void logout()} title={`Выйти: ${session.user.name}`}>
              Выйти
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

      {periodBar}
      {errorBox}

      <div className={`dash-row${d ? '' : ' loading'}`}>
        <div className={`dash-tile${openlines && d?.chats?.waitingReply ? ' warn' : ''}`}>
          <DashBadge name="alert" />
          <span className="dash-tile-label">Чатов ждут ответа</span>
          <span className="dash-tile-value">{openlines ? n(d?.chats?.waitingReply) : '—'}</span>
          {openlines ? (
            // Чаты → «Все доступные» → «Все».
            <button className="primary dash-tile-action" onClick={() => onChats({})}>
              Открыть чаты
            </button>
          ) : (
            <span className="dash-tile-hint">Открытые линии не включены в ваших группах</span>
          )}
        </div>
        <div className="dash-tile" title="Активные брони на ресурсах ваших групп: на сегодня / на завтра">
          <DashBadge name="calendar" />
          <span className="dash-tile-label">Бронирований сегодня / завтра</span>
          <span className="dash-tile-value">
            {n(d?.bookingDays?.today)}
            <small> / {n(d?.bookingDays?.tomorrow)}</small>
          </span>
          <button className="dash-tile-action" disabled={!d?.bookingDays} onClick={() => setDaysOpen(true)}>
            Календарь
          </button>
        </div>
        <div className="dash-tile">
          <DashBadge name="phone" />
          <span className="dash-tile-label">Все звонки {word}</span>
          <span className="dash-tile-value">{n(d?.callsTotal)}</span>
          <button className="dash-tile-action" onClick={() => setView('calls')}>
            Показать звонки
          </button>
        </div>
        <div className="dash-tile">
          <DashBadge name="person" />
          <span className="dash-tile-label">Новых сделок {word}</span>
          <span className="dash-tile-value">{n(d?.newDeals === null ? null : d?.newDeals?.total)}</span>
          <button className="dash-tile-action" disabled={!d?.newDeals?.total} onClick={() => setDealsOpen('all')}>
            Показать сделки
          </button>
        </div>
        <div className="dash-tile">
          <DashBadge name="people" />
          <span className="dash-tile-label">Повторные клиенты</span>
          <span className="dash-tile-value">
            {n(d?.newDeals === null ? null : d?.newDeals?.repeat)}
            {!!d?.newDeals?.total && <small> из {d.newDeals.total}</small>}
          </span>
          <button className="dash-tile-action" disabled={!d?.newDeals?.repeat} onClick={() => setDealsOpen('repeat')}>
            Показать
          </button>
        </div>
      </div>
      {d && d.newDeals === null && <p className="muted dash-note">Новые сделки недоступны: нет доступа к сделкам CRM.</p>}

      <div className="dash-pair">
      <div className="dash-col">
      {openlines && (
        <section className="day-panel dash-block dash-attention">
          <DashBadge name="chats" />
          <p className="dash-attention-title muted">
            Последние сообщения клиентов без ответа
            {d?.chats && <span className={`pill${d.chats.waitingReply ? ' waiting' : ''}`}>{d.chats.waitingReply}</span>}
          </p>
          {!d && <p className="muted">Загрузка…</p>}
          {d?.chats && !d.chats.attention?.length && <p className="muted">Все клиенты получили ответ.</p>}
          <ul className="attention-rows">
            {d?.chats?.attention?.slice(0, attentionShown).map((c) => (
              <li key={c.chatId}>
                <button className="attention-row" onClick={() => onChats({ chatId: c.chatId })}>
                  <span className="attention-title">
                    <b title={c.title}>{c.clientName || c.title}</b>
                    <Channel connector={c.connector} />
                  </span>
                  <span className="attention-preview muted">{c.preview || (c.hasFiles ? '📎 Файл' : 'Сообщение клиента')}</span>
                  <span className="attention-time">{fmtDateTime(c.lastMessageAt, tz)}</span>
                </button>
                {c.dealId && (
                  <button className="link attention-deal" onClick={() => openCrm('deal', c.dealId!)}>
                    Сделка #{c.dealId}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {!!d?.chats &&
            ((d.chats.attention?.length ?? 0) > attentionShown ? (
              <button className="dash-more" onClick={() => setAttentionShown((n) => n + ATTENTION_STEP)}>
                Ещё {Math.min(ATTENTION_STEP, (d.chats.attention?.length ?? 0) - attentionShown)}
              </button>
            ) : (
              d.chats.waitingReply > (d.chats.attention?.length ?? 0) && (
                <button className="dash-more" onClick={() => onChats({ waiting: true })}>
                  Все ждущие ответа ({d.chats.waitingReply})
                </button>
              )
            ))}
        </section>
      )}
        <RecentCalls scope={callsScope} timezone={tz} />
      </div>
      <div className="dash-col">
        <TodayBookings d={d} tz={tz} />
        <DealsCreated d={d} tz={tz} word={word} />
      </div>
      </div>

      {session.canManageApp && <EmployeeActivity timezone={tz} />}

      {d?.newDeals && d.newDeals.total > 0 && <DealSources items={d.newDeals.items} word={word} onOpen={(source) => setDealsOpen({ source })} />}

      <div className="dash-lists">
        <BookingList title="Новые бронирования" empty="Новых броней за период нет." list={d?.bookings?.created} tz={tz} variant="created" />
        <BookingList title="Удалённые бронирования" empty="Удалённых броней за период нет." list={d?.bookings?.removed} tz={tz} variant="removed" />
      </div>
      <p className="muted dash-note">
        Новые сделки — созданные {word} в воронках ваших групп; повторный клиент — у контакта уже была состоявшаяся сделка той же
        воронки. Брони — все на ресурсах ваших групп: созданные в приложении и в самом Битрикс24 (их находит сверка раз в
        10 минут); удалённые остаются в истории приложения.
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
              <BookingMark state={i.booking} />
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
      {!rows && <p className="muted">Загрузка…</p>}
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

/** Бронь по сделке: 🪙 — есть и оплачена, 📅 — есть, не оплачена, иначе — «без брони». */
function BookingMark({ state }: { state: DashboardNewDeal['booking'] }) {
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

/** «Ещё N» для списков дашборда: сразу — 5 строк, кнопка добавляет по 5. */
const LIST_STEP = 5;
function MoreButton({ total, shown, onMore }: { total: number; shown: number; onMore: () => void }) {
  if (total <= shown) return null;
  return (
    <button className="dash-more" onClick={onMore}>
      Ещё {Math.min(LIST_STEP, total - shown)}
    </button>
  );
}

/** «Брони сегодня»: сделки с бронью на сегодня (зелёным), по 5. */
function TodayBookings({ d, tz }: { d: Partial<DashboardDto> | null; tz: string }) {
  const [shown, setShown] = useState(LIST_STEP);
  const booked = [...new Map((d?.bookingDays?.todayItems ?? []).filter((r) => r.dealId).map((r) => [r.dealId!, r])).values()];
  return (
    <section className="day-panel dash-block dash-today-bookings">
      <DashBadge name="calendar" />
      <p className="dash-attention-title muted">
        Брони сегодня
        {d?.bookingDays && <span className="pill">{booked.length}</span>}
      </p>
      {!d?.bookingDays && <p className="muted">Загрузка…</p>}
      <ul className="dt-rows">
        {booked.slice(0, shown).map((r) => (
          <li key={`b${r.bookingId}`}>
            <button className={`dt-row today${r.pendingRemoval ? ' missing' : ''}`} onClick={() => openCrm('deal', r.dealId!)}>
              <span className="dt-main">
                <b>{r.deal?.client || r.deal?.title || r.title || `Сделка #${r.dealId}`}</b>
                <span className="muted">
                  {r.resources.join(', ')}
                  {r.pendingRemoval ? ' · удалена в Битрикс24 — ждёт решения' : ''}
                </span>
              </span>
              <span className="dt-side">
                <span>{bookingRange(r.start, r.end, tz)}</span>
                {r.deal?.opportunity ? <span className="muted">{fmtMoney(r.deal.opportunity, r.deal.currency)}</span> : null}
              </span>
            </button>
          </li>
        ))}
        {d?.bookingDays && !booked.length && <li className="muted dt-empty">Броней по сделкам на сегодня нет.</li>}
      </ul>
      <MoreButton total={booked.length} shown={shown} onMore={() => setShown((n) => n + LIST_STEP)} />
    </section>
  );
}

/** «Сделки за сегодня» (или за период): созданные сделки со значком брони (🪙 — оплачена), по 5. */
function DealsCreated({ d, tz, word }: { d: Partial<DashboardDto> | null; tz: string; word: string }) {
  const [shown, setShown] = useState(LIST_STEP);
  const created = d?.newDeals?.items ?? [];
  return (
    <section className="day-panel dash-block dash-deals-created">
      <DashBadge name="handshake" />
      <p className="dash-attention-title muted">
        Сделки {word === 'сегодня' ? 'за сегодня' : word}
        {d?.newDeals && <span className="pill">{d.newDeals.total}</span>}
      </p>
      {(!d || d.newDeals === undefined) && <p className="muted">Загрузка…</p>}
      {d?.newDeals === null && <p className="muted">Нет доступа к сделкам CRM.</p>}
      <ul className="dt-rows">
        {created.slice(0, shown).map((i) => (
          <li key={`n${i.id}`}>
            <button className="dt-row" onClick={() => openCrm('deal', i.id)}>
              <span className="dt-main">
                <b>{i.contact?.name || i.title}</b>
                <span className="muted">
                  {fmtTime(i.createdAt, tz)}
                  {i.source ? ` · ${i.source.name}` : ''}
                  {i.repeat ? ' · повторный' : ''}
                </span>
              </span>
              <span className="dt-side">
                <BookingMark state={i.booking} />
                {i.opportunity ? <span className="muted">{fmtMoney(i.opportunity, i.currency)}</span> : null}
              </span>
            </button>
          </li>
        ))}
        {d?.newDeals && !created.length && <li className="muted dt-empty">Новых сделок нет.</li>}
      </ul>
      <MoreButton total={created.length} shown={shown} onMore={() => setShown((n) => n + LIST_STEP)} />
    </section>
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
      <div className="sheet calls-modal" role="dialog" aria-modal="true" aria-label="Брони на сегодня и завтра" onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>Брони</h3>
          <button aria-label="Закрыть" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="wz-seg dbm-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'today'} className={tab === 'today' ? 'active' : ''} onClick={() => setTab('today')}>
            Сегодня · {days.today}
          </button>
          <button role="tab" aria-selected={tab === 'tomorrow'} className={tab === 'tomorrow' ? 'active' : ''} onClick={() => setTab('tomorrow')}>
            Завтра · {days.tomorrow}
          </button>
        </div>
        {!rows.length && <p className="muted">Броней нет.</p>}
        <ul className="dt-rows">
          {rows.map((r) => (
            <li key={r.bookingId}>
              <button className={`dt-row${r.pendingRemoval ? ' today missing' : ''}`} disabled={!r.dealId} onClick={() => r.dealId && openCrm('deal', r.dealId)}>
                <span className="dt-main">
                  <b>{r.dealId ? r.deal?.title || r.title || `Сделка #${r.dealId}` : r.title || 'Служебная бронь'}</b>
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
    <section className="day-panel dash-sources">
      <p className="dash-attention-title muted">Источники новых сделок {word}</p>
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
