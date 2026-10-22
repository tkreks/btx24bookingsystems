import { useCallback, useEffect, useState } from 'react';
import {
  todayIn,
  CALL_KINDS,
  CALL_KIND_LABELS,
  type BookingAlertListDto,
  type CallKind,
  type CallScope,
  type DashboardBookingRow,
  type DashboardDto,
  type SessionInfo,
} from '@btx24/shared';
import { apiGet } from '../api.js';
import { fmtDateTime, fmtMoney, fmtTime } from '../format.js';
import { dayKey } from './chat-list.js';
import { TempAccessDialog } from '../settings/TempAccessDialog.js';
import { WorkdayButton } from '../workday/WorkdayButton.js';
import { CallLogModal } from './CallLogModal.js';
import { CallsModal } from './CallsModal.js';
import { PERIOD_PRESETS, periodError, presetRange, type PeriodPreset } from './period.js';

const CANCEL_REASON: Record<NonNullable<DashboardBookingRow['cancelReason']>, string> = {
  payment_timeout: 'не оплачена в срок',
  manual: 'отменена вручную',
  removed_in_bitrix: 'удалена в Битрикс24',
};

/** Дашборд менеджера: его показатели за выбранный период в рамках его прав; вход в чаты. */
export function DashboardPage({
  session,
  openlines,
  onBack,
  onChats,
  bookingAlerts = false,
  onAlerts,
  onSettings,
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
  onSession?: (s: SessionInfo) => void;
}) {
  const tz = session.portal.timezone;
  const [preset, setPreset] = useState<PeriodPreset>('today');
  const [range, setRange] = useState(() => presetRange('today', todayIn(tz)));
  const [draft, setDraft] = useState(range);
  const [data, setData] = useState<DashboardDto | null>(null);
  const [error, setError] = useState('');
  const [alertCount, setAlertCount] = useState<number | null>(null);
  const [askCode, setAskCode] = useState(false);
  const [callsScope, setCallsScope] = useState<CallScope>('all');
  const [logOpen, setLogOpen] = useState(false);
  const closeLog = useCallback(() => setLogOpen(false), []);
  const [callsOpen, setCallsOpen] = useState<CallKind | null>(null);
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

  useEffect(() => {
    let active = true;
    const funnel = callsFunnel === null ? '' : `&callsFunnel=${callsFunnel}`;
    apiGet<DashboardDto>(`/dashboard?from=${range.from}&to=${range.to}&callsScope=${callsScope}${funnel}`).then(
      (dto) => {
        if (active) {
          setData(dto);
          setError('');
        }
      },
      (e) => active && setError(e instanceof Error ? e.message : 'Не удалось загрузить дашборд'),
    );
    return () => {
      active = false;
    };
  }, [range, callsScope, callsFunnel]);

  const choose = (p: PeriodPreset) => {
    setPreset(p);
    if (p !== 'custom') setRange(presetRange(p, todayIn(tz)));
    else setDraft(range);
  };
  const draftError = periodError(draft.from, draft.to);

  const d =
    data?.from === range.from &&
    data.to === range.to &&
    data.callsScope === callsScope &&
    (callsFunnel === null || data.callsFunnel === callsFunnel)
      ? data
      : null;
  const funnels = data?.callFunnels ?? [];
  const n = (v: number | null | undefined) => (v === null || v === undefined ? '—' : String(v));

  return (
    <div className="page dashboard">
      <header className="toolbar">
        <div className="toolbar-title">
          <button aria-label="К календарю" onClick={onBack}>
            ‹
          </button>
          <h1>Мой дашборд</h1>
          <span className="muted">{session.user.name}</span>
        </div>
        <div className="toolbar-controls">
        <WorkdayButton timezone={tz} />
        {onSettings && (
          <button
            className="settings-button"
            onClick={() => (session.canManageApp ? onSettings() : setAskCode(true))}
            title={session.canManageApp ? 'Настройки приложения' : 'Настройки — для администраторов или по временному паролю'}
          >
            <span aria-hidden="true">⚙</span> Настройки
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
      </div>

      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}

      <div className={`tiles${d ? '' : ' loading'}`}>
        {openlines && (
          <>
            <div className="tile accent">
              <span className="tile-value">{n(d?.chats?.waitingReply)}</span>
              <span className="tile-label">Чатов ждут ответа</span>
              <button className="primary tile-action" onClick={() => onChats({})}>
                Открыть чаты
              </button>
            </div>
            <div className="tile">
              <span className="tile-value">{n(d?.chats?.unreadMessages)}</span>
              <span className="tile-label">Непрочитанных сообщений</span>
            </div>
            <div className="tile">
              <span className="tile-value">{n(d?.contacts?.leads)}</span>
              <span className="tile-label">Лидов — было общение</span>
            </div>
            <div className="tile">
              <span className="tile-value">{n(d?.contacts?.contacts)}</span>
              <span className="tile-label">Контактов — было общение</span>
            </div>
            <div className="tile">
              <span className="tile-value">{n(d?.contacts?.deals)}</span>
              <span className="tile-label">Сделок — было общение</span>
            </div>
          </>
        )}
        {bookingAlerts && (
          <div className={`tile${alertCount ? ' accent' : ''}`}>
            <span className="tile-value">{n(alertCount)}</span>
            <span className="tile-label">Новых уведомлений о бронях</span>
            <button className="tile-action" onClick={onAlerts}>
              Открыть уведомления
            </button>
          </div>
        )}
        <div className="tile" title="Брони, созданные вами через приложение">
          <span className="tile-value">{n(d?.bookings.created)}</span>
          <span className="tile-label">Создано броней</span>
        </div>
        <div className="tile" title="Ваши брони, отменённые за период">
          <span className="tile-value">{n(d?.bookings.cancelled)}</span>
          <span className="tile-label">Отменено броней</span>
        </div>
      </div>
      {!openlines && (
        <p className="notice">Открытые линии недоступны: в ваших группах не включено право на них.</p>
      )}

      <section className="day-panel calls-panel">
        <div className="day-header">
          <b>Звонки — клиенты</b>
          {funnels.length > 1 && (
            <label className="calls-funnel">
              Повторные по воронке{' '}
              <select
                value={callsFunnel ?? data?.callsFunnel ?? ''}
                onChange={(e) => setCallsFunnel(Number(e.target.value))}
              >
                {funnels.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="segmented period-presets" role="group" aria-label="Чьи звонки">
            {(['all', 'mine'] as const).map((s) => (
              <button key={s} className={callsScope === s ? 'active' : ''} onClick={() => setCallsScope(s)}>
                {s === 'all' ? 'Все' : 'Мои'}
              </button>
            ))}
          </div>
        </div>
        {d && d.calls === null ? (
          <p className="muted">Статистика звонков недоступна: нет доступа к делам CRM.</p>
        ) : (
          <div className={`tiles call-tiles${d ? '' : ' loading'}`}>
            <div className="tile call-today">
              <span className="tile-value">{n(d?.callsToday)}</span>
              <span className="tile-label">Все звонки сегодня</span>
              <button className="tile-action" disabled={!d} onClick={() => setLogOpen(true)}>
                Показать звонки
              </button>
            </div>
            {CALL_KINDS.map((k) => (
              <button
                key={k}
                className={`tile${k === 'lost' && d?.calls?.lost ? ' accent' : ''}`}
                disabled={!d}
                onClick={() => setCallsOpen(k)}
              >
                <span className="tile-value">{n(d?.calls?.[k])}</span>
                <span className="tile-label">{CALL_KIND_LABELS[k]}</span>
              </button>
            ))}
          </div>
        )}
        <p className="muted dash-note">
          Считаются клиенты, а не звонки: несколько звонков от клиента и ему — один клиент. Повторный — есть
          состоявшаяся сделка в воронке {funnels.find((f) => f.id === d?.callsFunnel)?.name ?? 'группы'} до его первого
          звонка в периоде (не проиграна и бронь уже прошла; без брони — выигранная). Упущенный — после пропущенного не перезвонили и он сам не дозвонился («не дозвонились» на
          исходящих станет видно после выдачи приложению права «Телефония»).
        </p>
      </section>
      {logOpen && <CallLogModal scope={callsScope} timezone={tz} onClose={closeLog} />}
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

      <div className="dash-lists">
        <BookingList
          title="Сделки с бронью"
          empty="За период вы не создавали броней со сделками."
          rows={d?.bookings.deals}
          tz={tz}
          variant="created"
        />
        <BookingList
          title="Отменённые брони"
          empty="Отменённых броней за период нет."
          rows={d?.bookings.cancelledList}
          tz={tz}
          variant="cancelled"
        />
      </div>
      <p className="muted dash-note">Учитываются брони, созданные через приложение.</p>
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
  rows,
  tz,
  variant,
}: {
  title: string;
  empty: string;
  rows: DashboardBookingRow[] | undefined;
  tz: string;
  variant: 'created' | 'cancelled';
}) {
  const openDeal = (id: number) => window.BX24?.openPath?.(`/crm/deal/details/${id}/`);
  return (
    <section className="day-panel dash-list">
      <div className="day-header">
        <b>{title}</b>
        {rows && <span className="pill">{rows.length}</span>}
      </div>
      {!rows && <p className="muted">Загрузка…</p>}
      {rows && !rows.length && <p className="muted">{empty}</p>}
      <ul className="booking-rows">
        {rows?.map((r) => (
          <li key={r.bookingId} className="booking-row">
            <div className="booking-row-main">
              {r.dealId ? (
                <button className="link" onClick={() => openDeal(r.dealId!)}>
                  {r.deal?.title || `Сделка #${r.dealId}`}
                </button>
              ) : (
                <span>Служебная бронь</span>
              )}
              {r.deal && <span className="muted">{fmtMoney(r.deal.opportunity, r.deal.currency)}</span>}
            </div>
            <div className="booking-row-meta">
              <span>{bookingRange(r.start, r.end, tz)}</span>
              <span className="muted">{r.resources.join(', ')}</span>
            </div>
            <div className="booking-row-tags">
              {variant === 'cancelled' && r.cancelReason ? (
                <>
                  <span className={`pill${r.cancelReason === 'payment_timeout' ? ' waiting' : ' muted-pill'}`}>
                    {CANCEL_REASON[r.cancelReason]}
                  </span>
                  {r.cancelledAt && <span className="muted">отменена {fmtDateTime(r.cancelledAt, tz)}</span>}
                </>
              ) : (
                <>
                  {r.status === 'cancelled' && <span className="pill muted-pill">отменена</span>}
                  <span className="muted">создана {fmtDateTime(r.createdAt, tz)}</span>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
