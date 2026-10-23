import { useCallback, useEffect, useState } from 'react';
import {
  ALERT_STATUS_LABELS,
  ALERT_STATUSES,
  ALERT_TYPE_LABELS,
  alertType,
  type AlertResolution,
  type AlertStatus,
  type AlertType,
  type BookingAlertDto,
  type BookingAlertListDto,
  type BookingStateDto,
  type BookingVersionDto,
  type BookingVersionsDto,
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
  rolled_back: 'Откат к прежней версии',
};
/** Версий за раз в «Откатить» и «Истории изменений»; «Показать ещё» добавляет столько же. */
const VERSIONS_STEP = 3;

/**
 * Уведомления о бронях: новые брони мимо приложения и расхождения с Битрикс24. Карточка: дата и время
 * уведомления, тип (новое, изменение — оранжевым, удаление — красным, не снята), название и время
 * брони, «Показать изменения»; действия — «Перейти в сделку», «Принять» (данные Битрикс24),
 * «Откатить» (к выбранной версии из истории, по 3) и «История изменений». Статус — Новый / В работе /
 * Игнорировать; «Решено» ставит принятое решение.
 */
export function BookingAlertsPage({
  timezone,
  focusId,
  canEdit,
  canCancel,
  canCreate = false,
  onBack,
}: {
  timezone: string;
  focusId?: string | null;
  canEdit: boolean;
  canCancel: boolean;
  /** Право `booking.create` — «Создать бронирование в Битрикс24» по данным приложения. */
  canCreate?: boolean;
  onBack: () => void;
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
            onResolve={(resolution, versionId) => void act(a.id, () => apiPost(`/booking-alerts/${a.id}/resolve`, { resolution, ...(versionId ? { versionId } : {}) }))}
          />
        ))}
      </ul>
    </div>
  );
}

const ACCEPT_TEXT: Record<AlertType, string> = {
  new_booking: 'Принять новую бронь как есть? Она останется в Битрикс24 и в приложении.',
  change: 'Принять данные из Битрикс24? В приложении бронь станет такой же, это попадёт в историю.',
  removal: 'Принять удаление? Бронь будет удалена в приложении (в истории останется запись).',
  not_cancelled: 'Принять? Бронь снова станет активной в приложении — как в Битрикс24.',
};
const ROLLBACK_TEXT: Partial<Record<AlertType, string>> = {
  new_booking: 'Откатить — удалить эту бронь в Битрикс24? В приложении её не создавали.',
  not_cancelled: 'Откатить — удалить бронь в Битрикс24, как она снята в приложении?',
};

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
  onResolve: (r: AlertResolution, versionId?: string) => void;
}) {
  const [panel, setPanel] = useState<'diff' | 'rollback' | 'history' | null>(focused && alertType(a) === 'change' ? 'diff' : null);
  const type = alertType(a);
  const state = a.actual ?? a.expected;
  const dealId = a.actual?.dealId ?? a.expected?.dealId ?? a.dealId;
  const open = a.status !== 'resolved';
  const canAccept = type === 'removal' ? canCancel : canEdit;
  const canRollback = type === 'removal' ? canCreate : type === 'new_booking' || type === 'not_cancelled' ? canCancel : canEdit;
  const toggle = (p: NonNullable<typeof panel>) => setPanel(panel === p ? null : p);

  const accept = () => confirm(ACCEPT_TEXT[type]) && onResolve('accept_bitrix');
  const rollback = () => {
    const text = ROLLBACK_TEXT[type];
    if (text) return confirm(text) && onResolve('rollback');
    toggle('rollback');
  };

  return (
    <li className={`alert-card type-${type}${focused ? ' focused' : ''}${open ? '' : ' done'}`}>
      <div className="alert-top">
        <span className="alert-when">{fmtDateTime(a.createdAt, timezone)}</span>
        <span className={`pill alert-type ${type}`}>{ALERT_TYPE_LABELS[type]}</span>
        <span className={`pill alert-state ${a.status}`}>{ALERT_STATUS_LABELS[a.status]}</span>
      </div>
      <div className="alert-name">
        <strong>{a.title || `Бронь #${a.bookingId}`}</strong> <span className="muted">бронь #{a.bookingId}</span>
      </div>
      {state && (
        <div className="alert-booking">
          {range(state, timezone)} · {names(state.resourceIds)}
          {state.dealId ? ` · сделка #${state.dealId}` : ''}
        </div>
      )}
      {type === 'removal' && <p className="alert-note removal">Бронь удалена в Битрикс24 — в приложении она осталась.</p>}
      {type === 'not_cancelled' && <p className="alert-note">В приложении бронь снята, а в Битрикс24 осталась.</p>}
      {type === 'new_booking' && <p className="alert-note">Создана в Битрикс24 не через приложение.</p>}
      {type === 'change' && (
        <button className="link alert-diff-toggle" onClick={() => toggle('diff')}>
          {panel === 'diff' ? 'Скрыть изменения' : 'Показать изменения'}
        </button>
      )}
      {panel === 'diff' && a.expected && a.actual && <Diff before={a.expected} after={a.actual} tz={timezone} names={names} />}

      <div className="alert-actions">
        {dealId && (
          <button onClick={() => openCrm('deal', dealId)} disabled={busy}>
            Перейти в сделку
          </button>
        )}
        {open && (
          <>
            <button className="primary" onClick={accept} disabled={busy || !canAccept}>
              Принять
            </button>
            <button className={type === 'removal' ? 'danger-outline' : 'warn-outline'} onClick={rollback} disabled={busy || !canRollback} aria-expanded={panel === 'rollback'}>
              Откатить
            </button>
          </>
        )}
        <button className="link" onClick={() => toggle('history')} aria-expanded={panel === 'history'}>
          {panel === 'history' ? 'Скрыть историю' : 'История изменений'}
        </button>
      </div>
      {panel === 'rollback' && (
        <Versions
          bookingId={a.bookingId}
          timezone={timezone}
          names={names}
          busy={busy}
          hint={type === 'removal' ? 'Бронь будет создана в Битрикс24 заново по выбранной версии.' : 'Бронь в Битрикс24 вернётся к выбранной версии (время, ресурс, сделка).'}
          onPick={(v) => confirm(`Вернуть версию от ${fmtDateTime(v.at, timezone)}: ${range(v.state, timezone)}, ${names(v.state.resourceIds)}?`) && onResolve('rollback', v.id)}
        />
      )}
      {panel === 'history' && <Versions bookingId={a.bookingId} timezone={timezone} names={names} busy={busy} />}

      <div className="alert-status" role="group" aria-label={`Статус уведомления по брони ${a.bookingId}`}>
        {open &&
          ALERT_STATUSES.filter((s) => s !== 'resolved').map((s) => (
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
        {a.statusBy && a.statusAt && (
          <span className="muted">
            {ALERT_STATUS_LABELS[a.status]}: {a.statusBy.name}, {fmtDateTime(a.statusAt, timezone)}
          </span>
        )}
      </div>
      {!a.delivered && a.sendError && <p className="muted">В чат не отправлено: {a.sendError}</p>}
    </li>
  );
}

/** «Было (в приложении) → стало (в Битрикс24)»: изменённые строки — оранжевым. */
function Diff({ before, after, tz, names }: { before: BookingStateDto; after: BookingStateDto; tz: string; names: (ids: number[]) => string }) {
  const rows: [string, string, string][] = [
    ['Время', range(before, tz), range(after, tz)],
    ['Ресурс', names(before.resourceIds), names(after.resourceIds)],
    ['Сделка', before.dealId ? `#${before.dealId}` : 'без сделки', after.dealId ? `#${after.dealId}` : 'без сделки'],
  ];
  return (
    <table className="alert-diff">
      <thead>
        <tr>
          <th />
          <th>Было (в приложении)</th>
          <th>Стало (в Битрикс24)</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, b, c]) => (
          <tr key={label} className={b !== c ? 'changed' : ''}>
            <th>{label}</th>
            <td>{b}</td>
            <td>{c}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Версии данных брони из истории: по 3, «Показать ещё 3»; с `onPick` — «Вернуть эту версию». */
function Versions({
  bookingId,
  timezone,
  names,
  busy,
  hint,
  onPick,
}: {
  bookingId: number;
  timezone: string;
  names: (ids: number[]) => string;
  busy: boolean;
  hint?: string;
  onPick?: (v: BookingVersionDto) => void;
}) {
  const [items, setItems] = useState<BookingVersionDto[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const page = (offset: number) => apiGet<BookingVersionsDto>(`/bookings/${bookingId}/versions?offset=${offset}&limit=${VERSIONS_STEP}`);
  const failed = (e: unknown) => setError(e instanceof Error ? e.message : 'История недоступна');
  useEffect(() => {
    let active = true;
    apiGet<BookingVersionsDto>(`/bookings/${bookingId}/versions?offset=0&limit=${VERSIONS_STEP}`).then(
      (r) => {
        if (!active) return;
        setItems(r.items);
        setHasMore(r.hasMore);
      },
      (e) => active && failed(e),
    );
    return () => {
      active = false;
    };
  }, [bookingId]);
  const more = async () => {
    setLoading(true);
    try {
      const r = await page(items?.length ?? 0);
      setItems((prev) => [...(prev ?? []), ...r.items]);
      setHasMore(r.hasMore);
    } catch (e) {
      failed(e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="alert-versions">
      {hint && <p className="muted">{hint}</p>}
      {error && <p className="muted">{error}</p>}
      {!items && !error && <p className="muted">Загрузка версий…</p>}
      {items && !items.length && <p className="muted">Сохранённых версий нет.</p>}
      <ol>
        {items?.map((v) => (
          <li key={v.id} className={v.current ? 'current' : ''}>
            <div>
              <span className="muted">{fmtDateTime(v.at, timezone)}</span> <b>{ACTION_LABELS[v.action] ?? v.action}</b>
              {v.actorName ? <span className="muted"> — {v.actorName}</span> : null}
              {v.current && <span className="pill">сейчас в приложении</span>}
            </div>
            <div>
              {range(v.state, timezone)} · {names(v.state.resourceIds)} · {v.state.dealId ? `сделка #${v.state.dealId}` : 'без сделки'}
            </div>
            {onPick && (
              <button className="warn-outline" disabled={busy} onClick={() => onPick(v)}>
                Вернуть эту версию
              </button>
            )}
          </li>
        ))}
      </ol>
      {hasMore && (
        <button className="dash-more" disabled={loading} onClick={() => void more()}>
          Показать ещё {VERSIONS_STEP}
        </button>
      )}
    </div>
  );
}

function range(s: BookingStateDto, tz: string): string {
  return dayKey(s.startsAt, tz) === dayKey(s.endsAt, tz)
    ? `${fmtDateTime(s.startsAt, tz)}–${fmtTime(s.endsAt, tz)}`
    : `${fmtDateTime(s.startsAt, tz)} – ${fmtDateTime(s.endsAt, tz)}`;
}
