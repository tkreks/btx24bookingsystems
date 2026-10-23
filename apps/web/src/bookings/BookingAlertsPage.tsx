import { useCallback, useEffect, useState } from 'react';
import {
  ALERT_PROBLEM_LABELS,
  ALERT_STATUS_LABELS,
  ALERT_STATUSES,
  type AlertResolution,
  type AlertStatus,
  type BookingAlertDto,
  type BookingAlertListDto,
  type BookingHistoryDto,
  type BookingStateDto,
} from '@btx24/shared';
import { apiGet, apiPost, apiPut } from '../api.js';
import { openCrm } from '../b24.js';
import { fmtDateTime, fmtTime } from '../format.js';
import { dayKey } from '../openlines/chat-list.js';

const ACTION_LABELS: Record<string, string> = {
  created: 'Создана в приложении',
  imported: 'Найдена в Битрикс24',
  changed_in_bitrix: 'Изменена в Битрикс24',
  removed_in_bitrix: 'Удалена в Битрикс24',
  discrepancy_found: 'Найдено расхождение',
  accepted_bitrix: 'Принято как в Битрикс24',
  deleted_in_bitrix: 'Удалена в Битрикс24 по решению',
  recreated_in_bitrix: 'Создана в Битрикс24 заново по данным приложения',
  cancelled: 'Отменена',
  paid: 'Оплата получена',
  payment_cancelled: 'Счёт закрыт как неоплаченный (вручную)',
};

/**
 * Уведомления о бронях: новые брони мимо приложения и расхождения с Битрикс24. У каждого — статус
 * (Новый / В работе / Решено / Игнорировать) и действия: сделка, изменить, отменить, история. Бронь
 * приложения, пропавшая в Битрикс24, решается кнопками «Создать бронирование в Битрикс24» или
 * «Удалить бронирование в приложении» (вместо «Решено»).
 */
export function BookingAlertsPage({
  timezone,
  focusId,
  canEdit,
  canCancel,
  canCreate = false,
  onBack,
  onOpenDay,
}: {
  timezone: string;
  focusId?: string | null;
  canEdit: boolean;
  canCancel: boolean;
  /** Право `booking.create` — «Создать бронирование в Битрикс24» по данным приложения. */
  canCreate?: boolean;
  onBack: () => void;
  /** «Изменить бронь» — открыть день брони в календаре. */
  onOpenDay: (date: string) => void;
}) {
  const [filter, setFilter] = useState<AlertStatus | ''>(focusId ? '' : 'new');
  const [data, setData] = useState<{ filter: AlertStatus | ''; list: BookingAlertListDto } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await apiGet<BookingAlertListDto>(`/booking-alerts${filter ? `?status=${filter}` : ''}`);
      setData({ filter, list });
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить уведомления');
    }
  }, [filter]);

  useEffect(() => {
    let active = true;
    apiGet<BookingAlertListDto>(`/booking-alerts${filter ? `?status=${filter}` : ''}`).then(
      (list) => {
        if (!active) return;
        setData({ filter, list });
        setError('');
      },
      (e) => active && setError(e instanceof Error ? e.message : 'Не удалось загрузить уведомления'),
    );
    return () => {
      active = false;
    };
  }, [filter]);

  const act = async (id: string, run: () => Promise<unknown>) => {
    setBusy(id);
    setError('');
    try {
      await run();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось выполнить действие');
    } finally {
      setBusy(null);
    }
  };

  const current = data?.filter === filter ? data.list : null;
  const names = (ids: number[]) => ids.map((id) => current?.resources[id] ?? `Ресурс ${id}`).join(', ') || '—';
  const total = current ? ALERT_STATUSES.reduce((n, s) => n + current.counts[s], 0) : 0;

  return (
    <div className="page alerts-page">
      <header className="toolbar">
        <div className="toolbar-title">
          <button aria-label="Назад" onClick={onBack}>
            ‹
          </button>
          <h1>Уведомления о бронях</h1>
        </div>
        <button onClick={() => void load()}>Обновить</button>
      </header>

      <div className="segmented period-presets" role="group" aria-label="Статус">
        <button className={filter === '' ? 'active' : ''} onClick={() => setFilter('')}>
          Все{current ? ` · ${total}` : ''}
        </button>
        {ALERT_STATUSES.map((s) => (
          <button key={s} className={filter === s ? 'active' : ''} onClick={() => setFilter(s)}>
            {ALERT_STATUS_LABELS[s]}
            {current ? ` · ${current.counts[s]}` : ''}
          </button>
        ))}
      </div>

      {current && !current.chatConfigured && (
        <p className="notice">
          Чат уведомлений ещё не создан — уведомления видны только здесь. Создать: ⚙ → «Приложение» → «Сверка с
          Битрикс24».
        </p>
      )}
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {!current && !error && <p className="muted">Загрузка…</p>}
      {current && !current.items.length && <p className="muted">Уведомлений нет.</p>}

      <ul className="alert-list">
        {current?.items.map((a) => (
          <AlertCard
            key={a.id}
            a={a}
            focused={a.id === focusId}
            busy={busy === a.id}
            timezone={timezone}
            names={names}
            canEdit={canEdit}
            canCancel={canCancel}
            canCreate={canCreate}
            onStatus={(status) => void act(a.id, () => apiPut(`/booking-alerts/${a.id}`, { status }))}
            onResolve={(resolution: AlertResolution) => {
              const missing = a.problems.includes('missing');
              const text =
                resolution === 'recreate'
                  ? `Создать бронь #${a.bookingId} в Битрикс24 заново по данным приложения? У брони будет новый номер.`
                  : resolution === 'cancel_booking'
                    ? `Отменить бронь #${a.bookingId}? Она будет удалена в Битрикс24, у нас останется со статусом «отменена».`
                    : missing
                      ? `Удалить бронь #${a.bookingId} в приложении? В истории брони останется запись.`
                      : `Принять бронь #${a.bookingId} как в Битрикс24? Запись приложения изменится, это попадёт в историю.`;
              if (confirm(text)) void act(a.id, () => apiPost(`/booking-alerts/${a.id}/resolve`, { resolution }));
            }}
            onOpenDay={onOpenDay}
          />
        ))}
      </ul>
    </div>
  );
}

function AlertCard({
  a,
  focused,
  busy,
  timezone,
  names,
  canEdit,
  canCancel,
  canCreate,
  onStatus,
  onResolve,
  onOpenDay,
}: {
  a: BookingAlertDto;
  focused: boolean;
  busy: boolean;
  timezone: string;
  names: (ids: number[]) => string;
  canEdit: boolean;
  canCancel: boolean;
  canCreate: boolean;
  onStatus: (s: AlertStatus) => void;
  onResolve: (r: AlertResolution) => void;
  onOpenDay: (date: string) => void;
}) {
  const [history, setHistory] = useState<BookingHistoryDto | null | 'error'>(null);
  const [showHistory, setShowHistory] = useState(false);
  const state = a.actual ?? a.expected;
  // Бронь приложения пропала в Битрикс24: «Решено» заменяют два решения.
  const missing = a.kind === 'discrepancy' && a.problems.includes('missing');
  const chips = ALERT_STATUSES.filter((s) => !(missing && s === 'resolved'));
  const dealId = a.actual?.dealId ?? a.expected?.dealId ?? a.dealId;
  const line = (s: BookingStateDto) =>
    `${range(s, timezone)} · ${names(s.resourceIds)} · ${s.dealId ? `сделка #${s.dealId}` : 'без сделки'}`;

  const toggleHistory = async () => {
    setShowHistory(!showHistory);
    if (history && history !== 'error') return;
    try {
      setHistory(await apiGet<BookingHistoryDto>(`/bookings/${a.bookingId}/history`));
    } catch {
      setHistory('error');
    }
  };

  return (
    <li className={`alert-card ${a.kind}${focused ? ' focused' : ''}`}>
      <div className="alert-head">
        <span className={`pill alert-kind ${a.kind}`}>
          {a.kind === 'new_booking' ? 'Новое бронирование' : 'Расхождение данных'}
        </span>
        <strong>
          Бронь #{a.bookingId}
          {a.actual?.title ? ` «${a.actual.title}»` : ''}
        </strong>
        <span className="muted">{fmtDateTime(a.createdAt, timezone)}</span>
      </div>

      {a.kind === 'discrepancy' && (
        <p className="alert-problems">Не совпало: {a.problems.map((p) => ALERT_PROBLEM_LABELS[p]).join('; ')}</p>
      )}
      <dl className="alert-states">
        {a.expected && (
          <>
            <dt>В приложении</dt>
            <dd>{line(a.expected)}</dd>
          </>
        )}
        <dt>В Битрикс24</dt>
        <dd>{a.actual ? line(a.actual) : 'брони нет'}</dd>
      </dl>

      <div className="alert-status" role="group" aria-label={`Статус уведомления по брони ${a.bookingId}`}>
        {chips.map((s) => (
          <button
            key={s}
            className={`status-chip ${s}${a.status === s ? ' active' : ''}`}
            aria-pressed={a.status === s}
            disabled={busy || !canEdit || a.status === s}
            onClick={() => onStatus(s)}
          >
            {ALERT_STATUS_LABELS[s]}
          </button>
        ))}
        {missing && a.status !== 'resolved' && (
          <>
            <button className="status-chip resolved" disabled={busy || !canCreate} onClick={() => onResolve('recreate')}>
              Создать бронирование в Битрикс24
            </button>
            <button className="status-chip danger" disabled={busy || !canCancel} onClick={() => onResolve('accept_bitrix')}>
              Удалить бронирование в приложении
            </button>
          </>
        )}
        {missing && a.status === 'resolved' && <span className="status-chip resolved active">{ALERT_STATUS_LABELS.resolved}</span>}
        {a.statusBy && a.statusAt && (
          <span className="muted">
            {a.statusBy.name}, {fmtDateTime(a.statusAt, timezone)}
          </span>
        )}
      </div>

      <div className="alert-actions">
        {dealId && (
          <button onClick={() => openCrm('deal', dealId)} disabled={busy}>
            Открыть сделку
          </button>
        )}
        {state && (
          <button onClick={() => onOpenDay(dayKey(state.startsAt, timezone))} disabled={busy}>
            Изменить бронь
          </button>
        )}
        {a.kind === 'discrepancy' && !missing && !a.problems.includes('not_cancelled') && (
          <button onClick={() => onResolve('accept_bitrix')} disabled={busy || !canEdit}>
            Принять как в Битрикс24
          </button>
        )}
        {!missing && (
          <button className="danger" onClick={() => onResolve('cancel_booking')} disabled={busy || !canCancel}>
            Отменить бронь
          </button>
        )}
        <button className="link" onClick={() => void toggleHistory()}>
          {showHistory ? 'Скрыть историю' : 'История брони'}
        </button>
      </div>
      {!a.delivered && a.sendError && <p className="muted">В чат не отправлено: {a.sendError}</p>}

      {showHistory && (
        <div className="alert-history">
          {history === null && <p className="muted">Загрузка истории…</p>}
          {history === 'error' && <p className="muted">История недоступна.</p>}
          {history && history !== 'error' && (
            <ol>
              {history.entries.map((h, i) => (
                <li key={i}>
                  <span className="muted">{fmtDateTime(h.at, timezone)}</span> <b>{ACTION_LABELS[h.action] ?? h.action}</b>
                  {' — '}
                  {h.actorName ?? (h.actorKind === 'system' ? 'Система' : h.actorKind === 'bitrix' ? 'Битрикс24' : 'сотрудник')}
                  {h.before && h.after && (
                    <div className="muted">
                      было: {range(h.before, timezone)}, {names(h.before.resourceIds)} → стало: {range(h.after, timezone)},{' '}
                      {names(h.after.resourceIds)}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </li>
  );
}

function range(s: BookingStateDto, tz: string): string {
  return dayKey(s.startsAt, tz) === dayKey(s.endsAt, tz)
    ? `${fmtDateTime(s.startsAt, tz)}–${fmtTime(s.endsAt, tz)}`
    : `${fmtDateTime(s.startsAt, tz)} – ${fmtDateTime(s.endsAt, tz)}`;
}
