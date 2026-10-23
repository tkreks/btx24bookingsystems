import { useEffect, useState } from 'react';
import { todayIn, type HeadDashboardDto, type HeadDayDto, type SessionInfo } from '@btx24/shared';
import { apiGet } from '../api.js';
import { shiftDate } from '../format.js';
import { EmployeeActivity } from './EmployeeActivity.js';
import { DashBadge } from './RecentCalls.js';
import { PERIOD_PRESETS, periodError, presetRange, type PeriodPreset } from './period.js';

/** Динамика — за столько дней, заканчивая концом выбранного периода. */
const TREND_DAYS = 14;

/**
 * Дашборд руководителя (⚙ → «Приложение» → «Руководители»): показатели периода — новые сделки, брони
 * по ним, повторные клиенты; телефония — все звонки, пропущенные, упущенные; графики по дням за 14
 * дней и «Активность сотрудников» по часам.
 */
export function HeadDashboardPage({ session, onManager }: { session: SessionInfo; onManager: () => void }) {
  const tz = session.portal.timezone;
  const [preset, setPreset] = useState<PeriodPreset>('today');
  const [range, setRange] = useState(() => presetRange('today', todayIn(tz)));
  const [draft, setDraft] = useState(range);
  const [data, setData] = useState<{ key: string; dto: HeadDashboardDto } | null>(null);
  const [trend, setTrend] = useState<{ key: string; dto: HeadDashboardDto } | null>(null);
  const [error, setError] = useState('');

  const key = `${range.from}|${range.to}`;
  const trendFrom = shiftDate(range.to, -(TREND_DAYS - 1));
  const trendKey = `${trendFrom}|${range.to}`;
  useEffect(() => {
    let active = true;
    apiGet<HeadDashboardDto>(`/head-dashboard?from=${range.from}&to=${range.to}`).then(
      (dto) => {
        if (!active) return;
        setData({ key, dto });
        setError('');
      },
      (e) => active && setError(e instanceof Error ? e.message : 'Не удалось загрузить дашборд'),
    );
    apiGet<HeadDashboardDto>(`/head-dashboard?from=${trendFrom}&to=${range.to}`).then(
      (dto) => active && setTrend({ key: trendKey, dto }),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [key, trendKey, range.from, range.to, trendFrom]);

  const d = data?.key === key ? data.dto : null;
  const tr = trend?.key === trendKey ? trend.dto : null;
  const n = (v: number | undefined, ok = true) => (!d ? '…' : ok ? String(v ?? 0) : '—');
  const word = preset === 'today' ? 'сегодня' : preset === 'yesterday' ? 'вчера' : 'за период';
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  const draftError = periodError(draft.from, draft.to);

  return (
    <div className="page dashboard head-dashboard">
      <header className="toolbar">
        <div className="toolbar-title">
          <h1>Дашборд руководителя</h1>
          <span className="muted">{session.user.name}</span>
        </div>
        <button onClick={onManager}>Дашборд менеджера</button>
      </header>

      <div className="period-bar">
        <div className="segmented period-presets" role="group" aria-label="Период">
          {PERIOD_PRESETS.map((p) => (
            <button
              key={p.key}
              className={preset === p.key ? 'active' : ''}
              onClick={() => {
                setPreset(p.key);
                if (p.key !== 'custom') setRange(presetRange(p.key, todayIn(tz)));
                else setDraft(range);
              }}
            >
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

      <h2 className="head-section">Сделки и брони</h2>
      <div className={`dash-row${d ? '' : ' loading'}`}>
        <div className="dash-tile">
          <DashBadge name="person" />
          <span className="dash-tile-label">Новых сделок {word}</span>
          <span className="dash-tile-value">{n(d?.totals.newDeals, d?.deals)}</span>
          <span className="dash-tile-hint">в воронках всех групп</span>
        </div>
        <div className="dash-tile">
          <DashBadge name="calendar" />
          <span className="dash-tile-label">Бронирований по новым сделкам</span>
          <span className="dash-tile-value">
            {n(d?.totals.bookings, d?.deals)}
            {d?.deals && <small> · сделок с бронью {d.totals.bookedDeals}</small>}
          </span>
          <span className="dash-tile-hint">конверсия в бронь: {d ? pct(d.totals.bookedDeals, d.totals.newDeals) : '…'}</span>
        </div>
        <div className="dash-tile">
          <DashBadge name="people" />
          <span className="dash-tile-label">Сделки повторных клиентов</span>
          <span className="dash-tile-value">
            {n(d?.totals.repeat, d?.deals)}
            {d?.deals && !!d.totals.newDeals && <small> из {d.totals.newDeals}</small>}
          </span>
          <span className="dash-tile-hint">у клиента раньше была бронь (состоялась)</span>
        </div>
      </div>
      {d && !d.deals && <p className="muted dash-note">Сделки недоступны: у вас нет доступа к сделкам CRM.</p>}

      <h2 className="head-section">Телефония</h2>
      <div className={`dash-row head-phone${d ? '' : ' loading'}`}>
        <div className="dash-tile">
          <DashBadge name="phone" />
          <span className="dash-tile-label">Звонков {word}</span>
          <span className="dash-tile-value">{n(d?.totals.calls, d?.calls)}</span>
          {d?.calls && (
            <span className="dash-tile-hint">
              входящих {d.totals.incoming} · исходящих {d.totals.outgoing}
            </span>
          )}
        </div>
        <div className={`dash-tile${d?.totals.missed ? ' warn' : ''}`}>
          <DashBadge name="phone" />
          <span className="dash-tile-label">Пропущенных</span>
          <span className="dash-tile-value">{n(d?.totals.missed, d?.calls)}</span>
          <span className="dash-tile-hint">входящие без ответа</span>
        </div>
        <div className={`dash-tile${d?.totals.lost ? ' warn' : ''}`}>
          <DashBadge name="alert" />
          <span className="dash-tile-label">Упущенных клиентов</span>
          <span className="dash-tile-value">{n(d?.totals.lost, d?.calls)}</span>
          <span className="dash-tile-hint">не перезвонили и не написали в чат</span>
        </div>
      </div>
      {d && !d.calls && <p className="muted dash-note">Звонки недоступны: у вас нет доступа к делам CRM.</p>}
      {d?.notes.map((x) => (
        <p key={x} className="muted dash-note">
          {x}
        </p>
      ))}

      <div className="head-charts">
        <section className="day-panel dash-block">
          <DashBadge name="person" />
          <p className="dash-attention-title muted">Сделки за {TREND_DAYS} дней</p>
          <BarChart
            days={tr?.days ?? null}
            tz={tz}
            series={[
              { key: 'newDeals', label: 'Новые сделки', color: '#3269f6' },
              { key: 'bookedDeals', label: 'С бронью', color: '#16a34a' },
              { key: 'repeat', label: 'Повторные клиенты', color: '#9e77ed' },
            ]}
          />
        </section>
        <section className="day-panel dash-block">
          <DashBadge name="phone" />
          <p className="dash-attention-title muted">Звонки за {TREND_DAYS} дней</p>
          <BarChart
            days={tr?.days ?? null}
            tz={tz}
            series={[
              { key: 'calls', label: 'Все звонки', color: '#3269f6' },
              { key: 'missed', label: 'Пропущенные', color: '#f79009' },
              { key: 'lost', label: 'Упущенные', color: '#d92d20' },
            ]}
          />
        </section>
      </div>

      <EmployeeActivity timezone={tz} />
      <p className="muted dash-note">
        Новые сделки — созданные в воронках всех групп приложения; брони — из журнала приложения (созданные в приложении и найденные сверкой).
        Упущенный клиент — последний его звонок пропущен, после него ему не перезванивали и не писали в чат открытой линии.
      </p>
    </div>
  );
}

type SeriesKey = keyof Omit<HeadDayDto, 'date'>;

/** Столбцы по дням: несколько показателей рядом; подписи дней снизу, значения — в подсказке. */
function BarChart({ days, series, tz }: { days: HeadDayDto[] | null; series: { key: SeriesKey; label: string; color: string }[]; tz: string }) {
  if (!days) return <p className="muted">Загрузка…</p>;
  const max = Math.max(1, ...days.flatMap((d) => series.map((s) => d[s.key])));
  const W = 640;
  const H = 180;
  const pad = { l: 28, r: 8, t: 10, b: 26 };
  const slot = (W - pad.l - pad.r) / days.length;
  const bar = Math.max(3, Math.min(14, (slot - 6) / series.length));
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const label = (date: string) => new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: '2-digit', month: '2-digit' }).format(new Date(`${date}T12:00:00Z`));
  const ticks = [0, Math.round(max / 2), max].filter((v, i, a) => a.indexOf(v) === i);
  return (
    <figure className="bar-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={series.map((s) => s.label).join(', ')}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="bc-grid" />
            <text x={pad.l - 6} y={y(v) + 4} textAnchor="end" className="bc-axis">
              {v}
            </text>
          </g>
        ))}
        {days.map((d, i) => {
          const x0 = pad.l + i * slot + (slot - bar * series.length) / 2;
          return (
            <g key={d.date}>
              {series.map((s, j) => (
                <rect key={s.key} x={x0 + j * bar} y={y(d[s.key])} width={bar - 1} height={Math.max(0, H - pad.b - y(d[s.key]))} fill={s.color} rx={2}>
                  <title>{`${label(d.date)} · ${s.label}: ${d[s.key]}`}</title>
                </rect>
              ))}
              {(days.length <= 14 || i % 2 === 0) && (
                <text x={pad.l + i * slot + slot / 2} y={H - 8} textAnchor="middle" className="bc-axis">
                  {label(d.date)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="bc-legend">
        {series.map((s) => (
          <span key={s.key}>
            <i style={{ background: s.color }} /> {s.label}: <b>{days.reduce((n, d) => n + d[s.key], 0)}</b>
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
