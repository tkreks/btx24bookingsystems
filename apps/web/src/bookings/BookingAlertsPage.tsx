import { ContactAlertRow } from './ContactAlertsPanel.js';
import { bookingSeverity, bulkAcceptable, mergeTimeline, SEVERITY_LABELS } from './notifications.js';
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
  type ContactAlertListDto,
} from '@btx24/shared';
import { ApiRequestError, apiGet, apiPost, apiPut } from '../api.js';
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
  const [data, setData] = useState<{ filter: AlertStatus | ''; list: BookingAlertListDto; contacts: ContactAlertListDto | null } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [bulk, setBulk] = useState('');

  // Брони и контакты — одной лентой; уведомления контактов только администраторам (403 — без них).
  const fetchAll = useCallback(async (status: AlertStatus | '') => {
    const q = status ? `?status=${status}` : '';
    const [list, contacts] = await Promise.all([
      apiGet<BookingAlertListDto>(`/booking-alerts${q}`),
      apiGet<ContactAlertListDto>(`/contact-alerts${q}`).catch((e) => {
        if (e instanceof ApiRequestError && e.status === 403) return null;
        throw e;
      }),
    ]);
    return { filter: status, list, contacts };
  }, []);
  const load = useCallback(async () => {
    try {
      setData(await fetchAll(filter));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить уведомления');
    }
  }, [fetchAll, filter]);

  useEffect(() => {
    let active = true;
    fetchAll(filter).then(
      (d) => {
        if (!active) return;
        setData(d);
        setError('');
      },
      (e) => active && setError(e instanceof Error ? e.message : 'Не удалось загрузить уведомления'),
    );
    return () => {
      active = false;
    };
  }, [fetchAll, filter]);

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

  const current = data?.filter === filter ? data : null;
  const names = (ids: number[]) => ids.map((id) => current?.list.resources[id] ?? `Ресурс ${id}`).join(', ') || '—';
  const count = (s: AlertStatus) => (current ? current.list.counts[s] + (current.contacts?.counts[s] ?? 0) : 0);
  const total = ALERT_STATUSES.reduce((n, s) => n + count(s), 0);
  const items = current ? mergeTimeline(current.list.items, current.contacts?.items ?? []) : [];
  const moreContacts = async () => {
    if (!current?.contacts?.nextCursor) return;
    setBusy('more');
    try {
      const next = await apiGet<ContactAlertListDto>(`/contact-alerts?${filter ? `status=${filter}&` : ''}before=${encodeURIComponent(current.contacts.nextCursor)}`);
      setData((d) => (d && d.contacts ? { ...d, contacts: { ...next, items: [...d.contacts.items, ...next.items.filter((i) => !d.contacts!.items.some((p) => p.id === i.id))] } } : d));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить ещё');
    } finally {
      setBusy(null);
    }
  };

  // «Принять все изменения»: контакты — «принято», брони — изменения и новые (как в Битрикс24).
  // Удаления и неснятые брони (красные) не трогаем — их проверяют по одной.
  const openContacts = (current?.contacts?.items ?? []).filter((a) => a.status === 'new' || a.status === 'viewed');
  const openBookings = canEdit ? (current?.list.items ?? []).filter(bulkAcceptable) : [];
  const skipped = (current?.list.items ?? []).filter((a) => (a.status === 'new' || a.status === 'viewed') && !bulkAcceptable(a)).length;
  const acceptAll = async () => {
    const parts = [openBookings.length && `брони: ${openBookings.length}`, openContacts.length && `контакты: ${openContacts.length}`].filter(Boolean).join(', ');
    if (!confirm(`Принять все изменения (${parts})? Данные приложения станут как в Битрикс24.${skipped ? ` Удаления броней (${skipped}) нужно проверить отдельно.` : ''}`)) return;
    setBusy('bulk');
    setError('');
    let done = 0;
    const failed: string[] = [];
    try {
      if (openContacts.length) {
        const r = await apiPost<{ updated: number }>('/contact-alerts/bulk', { ids: openContacts.map((a) => a.id), status: 'resolved' });
        done += r.updated;
      }
      for (const a of openBookings) {
        setBulk(`Принимаем… ${done + 1}`);
        try {
          await apiPost(`/booking-alerts/${a.id}/resolve`, { resolution: 'accept_bitrix' });
          done++;
        } catch (e) {
          failed.push(`бронь #${a.bookingId}: ${e instanceof Error ? e.message : 'ошибка'}`);
        }
      }
      setBulk(`Принято: ${done}${failed.length ? `. Не удалось: ${failed.join('; ')}` : ''}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось принять изменения');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page alerts-page">
      <header className="toolbar">
        <div className="toolbar-title">
          <button aria-label="Назад" onClick={onBack}>
            ‹
          </button>
          <h1>Уведомления</h1>
        </div>
        <button onClick={() => void load()}>Обновить</button>
      </header>

      <div className="nt-toolbar">
        <div className="segmented period-presets" role="group" aria-label="Статус">
          <button className={filter === '' ? 'active' : ''} onClick={() => setFilter('')}>
            Все{current ? ` · ${total}` : ''}
          </button>
          {ALERT_STATUSES.map((s) => (
            <button key={s} className={filter === s ? 'active' : ''} onClick={() => setFilter(s)}>
              {ALERT_STATUS_LABELS[s]}
              {current ? ` · ${count(s)}` : ''}
            </button>
          ))}
        </div>
        {(openContacts.length > 0 || openBookings.length > 0) && (
          <button type="button" className="primary nt-accept-all" disabled={!!busy} onClick={() => void acceptAll()}>
            Принять все изменения · {openContacts.length + openBookings.length}
          </button>
        )}
      </div>
      <p className="nt-legend muted">
        <span className="nt-dot sev-info" /> не критично <span className="nt-dot sev-warning" /> обратите внимание <span className="nt-dot sev-critical" /> проверить!
      </p>

      {current && !current.list.chatConfigured && (
        <p className="notice">
          Чат уведомлений ещё не создан — уведомления видны только здесь. Создать: ⚙ → «Приложение» → «Сверка с
          Битрикс24».
        </p>
      )}
      {bulk && <p className="notice" role="status">{bulk}</p>}
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {!current && !error && <p className="muted">Загрузка…</p>}
      {current && !items.length && <p className="muted">Уведомлений нет.</p>}

      <ul className="nt-list">
        {items.map((it) =>
          it.kind === 'contact' ? (
            <ContactAlertRow
              key={`c${it.a.id}`}
              a={it.a}
              timezone={timezone}
              busy={!!busy}
              onStatus={(status) => void act(it.a.id, () => apiPut(`/contact-alerts/${it.a.id}`, { status }))}
            />
          ) : (
            <AlertCard
              key={`b${it.a.id}`}
              a={it.a}
              focused={it.a.id === focusId}
              busy={busy === it.a.id || busy === 'bulk'}
              timezone={timezone}
              names={names}
              canEdit={canEdit}
              canCancel={canCancel}
              canCreate={canCreate}
              onStatus={(status) => void act(it.a.id, () => apiPut(`/booking-alerts/${it.a.id}`, { status }))}
              onResolve={(resolution, versionId) => void act(it.a.id, () => apiPost(`/booking-alerts/${it.a.id}/resolve`, { resolution, ...(versionId ? { versionId } : {}) }))}
            />
          ),
        )}
      </ul>
      {current?.contacts?.nextCursor && (
        <button type="button" className="dash-more" disabled={!!busy} onClick={() => void moreContacts()}>
          Показать ещё
        </button>
      )}
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

  const sev = bookingSeverity(a);
  return (
    <li className={`nt-row nt-booking sev-${sev} alert-card type-${type}${focused ? ' focused' : ''}${open ? '' : ' done'}`}>
      <span className="nt-dot" title={SEVERITY_LABELS[sev]} aria-label={SEVERITY_LABELS[sev]} />
      <div className="nt-body">
      <div className="nt-line">
        <b className="nt-title">{ALERT_TYPE_LABELS[type]}</b>
        <span className="nt-subject">{a.title || `Бронь #${a.bookingId}`}</span>
        <span className="nt-meta muted">
          {fmtDateTime(a.createdAt, timezone)} · бронь #{a.bookingId}
        </span>
        <span className={`nt-status ${a.status}`}>{ALERT_STATUS_LABELS[a.status]}</span>
      </div>
      {state && (
        <div className="nt-booking-state">
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
      </div>
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
