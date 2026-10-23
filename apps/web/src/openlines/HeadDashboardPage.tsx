import { useEffect, useState } from 'react';
import { todayIn, type HeadDashboardDto, type HeadDayDto, type HeadTotalsDto, type SessionInfo } from '@btx24/shared';
import { apiGet } from '../api.js';
import { shiftDate } from '../format.js';

/** «23 октября 2026». */
const fmtDay = (date: string, tz: string) =>
  new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${date}T12:00:00Z`));
import { EmployeeActivity } from './EmployeeActivity.js';
import { DashBadge } from './RecentCalls.js';
import { periodError } from './period.js';
import { Avatar } from './Avatar.js';

type Preset = 'today' | 'yesterday' | 'custom';

/**
 * Дашборд руководителя (⚙ → «Приложение» → «Руководители»): все показатели и графики — за выбранный
 * период (по умолчанию сегодня; «Вчера»; «Период…» — окно с началом и концом), «Активность
 * сотрудников» — на первый день периода (дальше листается по дням).
 */
export function HeadDashboardPage({ session, onManager }: { session: SessionInfo; onManager: () => void }) {
  const tz = session.portal.timezone;
  const today = todayIn(tz);
  const [preset, setPreset] = useState<Preset>('today');
  const [range, setRange] = useState({ from: today, to: today });
  const [picking, setPicking] = useState<{ from: string; to: string } | null>(null);
  const [data, setData] = useState<{ key: string; dto: HeadDashboardDto } | null>(null);
  const [error, setError] = useState('');

  const key = `${range.from}|${range.to}`;
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
    return () => {
      active = false;
    };
  }, [key, range.from, range.to]);

  const d = data?.key === key ? data.dto : null;
  const n = (v: number | undefined, ok = true) => (!d ? '…' : ok ? String(v ?? 0) : '—');
  const word = preset === 'today' ? 'сегодня' : preset === 'yesterday' ? 'вчера' : 'за период';
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  // Прошлый период той же длины — для сравнения на плитках.
  const p = d?.previous?.totals;
  const vs = {
    label: preset === 'today' ? 'ко вчера' : preset === 'yesterday' ? 'к позавчера' : 'к прошлому периоду',
    title: d?.previous ? `Прошлый период: ${d.previous.from === d.previous.to ? fmtDay(d.previous.from, tz) : `${fmtDay(d.previous.from, tz)} — ${fmtDay(d.previous.to, tz)}`}` : '',
  };
  const periodText = range.from === range.to ? fmtDay(range.from, tz) : `${fmtDay(range.from, tz)} — ${fmtDay(range.to, tz)}`;
  const pickError = picking ? periodError(picking.from, picking.to) : null;
  const choose = (p: Exclude<Preset, 'custom'>) => {
    setPreset(p);
    const day = p === 'today' ? today : shiftDate(today, -1);
    setRange({ from: day, to: day });
  };

  return (
    <div className="page dashboard head-dashboard">
      <header className="toolbar">
        <div className="toolbar-title">
          <h1>Дашборд руководителя</h1>
          <span className="muted toolbar-user">
            <Avatar src={session.user.photo} name={session.user.name} size={26} />
            {session.user.name}
          </span>
        </div>
        <button onClick={onManager}>Дашборд менеджера</button>
      </header>

      <div className="period-bar head-period">
        <span className="head-period-text" aria-live="polite">
          {periodText}
        </span>
        <div className="segmented period-presets" role="group" aria-label="Период">
          <button className={preset === 'today' ? 'active' : ''} onClick={() => choose('today')}>
            Сегодня
          </button>
          <button className={preset === 'yesterday' ? 'active' : ''} onClick={() => choose('yesterday')}>
            Вчера
          </button>
          <button className={preset === 'custom' ? 'active' : ''} aria-haspopup="dialog" onClick={() => setPicking(range)}>
            Период…
          </button>
        </div>
      </div>
      {picking && (
        <div className="sheet-backdrop" onClick={() => setPicking(null)}>
          <form
            className="sheet head-period-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Период"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              if (pickError) return;
              setRange(picking);
              setPreset(picking.from === today && picking.to === today ? 'today' : 'custom');
              setPicking(null);
            }}
          >
            <header>
              <h3>Период</h3>
              <button type="button" aria-label="Закрыть" onClick={() => setPicking(null)}>
                ×
              </button>
            </header>
            <div className="head-period-fields">
              <label>
                Начало
                <input type="date" value={picking.from} max={today} onChange={(e) => setPicking({ ...picking, from: e.target.value })} />
              </label>
              <label>
                Конец
                <input type="date" value={picking.to} max={today} onChange={(e) => setPicking({ ...picking, to: e.target.value })} />
              </label>
            </div>
            {pickError && <p className="notice error">{pickError}</p>}
            <div className="form-actions">
              <button type="submit" className="primary" disabled={!!pickError}>
                Показать
              </button>
              <button type="button" onClick={() => setPicking(null)}>
                Отмена
              </button>
            </div>
          </form>
        </div>
      )}
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}

      <h2 className="head-section">Сделки и брони</h2>
      <div className={`dash-row${d ? '' : ' loading'}`}>
        <div className={`dash-tile${p && d?.deals ? toneClass(d.totals.newDeals, p.newDeals) : ''}`}>
          <DashBadge name="person" />
          <span className="dash-tile-label">Новых сделок {word}</span>
          <span className="dash-tile-value">{n(d?.totals.newDeals, d?.deals)}</span>
          {p && d?.deals && <Trend cur={d.totals.newDeals} prev={p.newDeals} vs={vs} />}
          <span className="dash-tile-hint">в воронках всех групп</span>
        </div>
        <div className={`dash-tile${p && d?.deals ? toneClass(conv(d.totals), conv(p)) : ''}`}>
          <DashBadge name="calendar" />
          <span className="dash-tile-label">Бронирований по новым сделкам</span>
          <span className="dash-tile-value">
            {n(d?.totals.bookings, d?.deals)}
            {d?.deals && <small> · сделок с бронью {d.totals.bookedDeals}</small>}
          </span>
          <span className="dash-tile-hint">
            конверсия в бронь: {d ? pct(d.totals.bookedDeals, d.totals.newDeals) : '…'}
            {p && d?.deals && <ConvTrend cur={conv(d.totals)} prev={conv(p)} vs={vs} />}
          </span>
        </div>
        <div className="dash-tile">
          <DashBadge name="people" />
          <span className="dash-tile-label">Сделки повторных клиентов</span>
          <span className="dash-tile-value">{n(d?.totals.repeat, d?.deals)}</span>
          <span className="dash-tile-hint">у клиента раньше была бронь (состоялась)</span>
        </div>
      </div>
      {d && !d.deals && <p className="muted dash-note">Сделки недоступны: у вас нет доступа к сделкам CRM.</p>}

      <h2 className="head-section">Телефония</h2>
      <div className={`dash-row head-phone${d ? '' : ' loading'}`}>
        <div className={`dash-tile${p && d?.calls ? toneClass(d.totals.calls, p.calls) : ''}`}>
          <DashBadge name="phone" />
          <span className="dash-tile-label">Звонков {word}</span>
          <span className="dash-tile-value">{n(d?.totals.calls, d?.calls)}</span>
          {p && d?.calls && <Trend cur={d.totals.calls} prev={p.calls} vs={vs} />}
          {d?.calls && (
            <span className="dash-tile-hint">
              входящих {d.totals.incoming} · исходящих {d.totals.outgoing}
            </span>
          )}
        </div>
        {/* Пропущенные и упущенные: лучше — меньше. */}
        <div className={`dash-tile${p && d?.calls ? toneClass(d.totals.missed, p.missed, true) : ''}`}>
          <DashBadge name="phone" />
          <span className="dash-tile-label">Пропущенных</span>
          <span className="dash-tile-value">{n(d?.totals.missed, d?.calls)}</span>
          {p && d?.calls && <Trend cur={d.totals.missed} prev={p.missed} vs={vs} lowerIsBetter />}
          <span className="dash-tile-hint">входящие без ответа</span>
        </div>
        <div className={`dash-tile${p && d?.calls ? toneClass(d.totals.lost, p.lost, true) : ''}`}>
          <DashBadge name="alert" />
          <span className="dash-tile-label">Упущенных клиентов</span>
          <span className="dash-tile-value">{n(d?.totals.lost, d?.calls)}</span>
          {p && d?.calls && <Trend cur={d.totals.lost} prev={p.lost} vs={vs} lowerIsBetter />}
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
          <p className="dash-attention-title muted">Сделки · {periodText}</p>
          <BarChart
            days={d?.days ?? null}
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
          <p className="dash-attention-title muted">Звонки · {periodText}</p>
          <BarChart
            days={d?.days ?? null}
            tz={tz}
            series={[
              { key: 'calls', label: 'Все звонки', color: '#3269f6' },
              { key: 'missed', label: 'Пропущенные', color: '#f79009' },
              { key: 'lost', label: 'Упущенные', color: '#d92d20' },
            ]}
          />
        </section>
      </div>

      <EmployeeActivity timezone={tz} startDate={range.from} />
      <p className="muted dash-note">
        Новые сделки — созданные в воронках всех групп приложения; брони — из журнала приложения (созданные в приложении и найденные сверкой).
        Упущенный клиент — последний его звонок пропущен, после него ему не перезванивали и не писали в чат открытой линии.
      </p>
    </div>
  );
}

/** Конверсия новых сделок в бронь, целые %; сделок нет — null. */
const conv = (t: HeadTotalsDto) => (t.newDeals ? Math.round((t.bookedDeals / t.newDeals) * 100) : null);

/**
 * Рамка плитки по сравнению с прошлым периодом: лучше — зелёная, хуже — красная, так же — без рамки.
 * `lowerIsBetter` — для пропущенных и упущенных. Конверсия без сделок в одном из периодов — без рамки.
 */
function toneClass(cur: number | null, prev: number | null, lowerIsBetter = false): string {
  if (cur === null || prev === null || cur === prev) return '';
  return (cur > prev) !== lowerIsBetter ? ' trend-good' : ' trend-bad';
}

/** «▲ +12% ко вчера (25)»; прошлый период пуст — «▲ +4 ко вчера (0)». */
function Trend({ cur, prev, vs, lowerIsBetter = false }: { cur: number; prev: number; vs: { label: string; title: string }; lowerIsBetter?: boolean }) {
  const diff = cur - prev;
  const tone = diff === 0 ? 'same' : (diff > 0) !== lowerIsBetter ? 'good' : 'bad';
  const text = diff === 0 ? '0%' : prev ? `${diff > 0 ? '+' : '−'}${Math.round((Math.abs(diff) / prev) * 100)}%` : `${diff > 0 ? '+' : '−'}${Math.abs(diff)}`;
  return (
    <span className={`trend ${tone}`} title={vs.title}>
      {diff > 0 ? '▲' : diff < 0 ? '▼' : '='} {text} {vs.label} <span className="muted">({prev})</span>
    </span>
  );
}

/** Конверсия: разница в процентных пунктах с прошлым периодом. */
function ConvTrend({ cur, prev, vs }: { cur: number | null; prev: number | null; vs: { label: string; title: string } }) {
  if (cur === null || prev === null) return <span className="trend same" title={vs.title}> · {vs.label}: {prev === null ? 'сделок не было' : `${prev}%`}</span>;
  const diff = cur - prev;
  const tone = diff === 0 ? 'same' : diff > 0 ? 'good' : 'bad';
  return (
    <span className={`trend ${tone}`} title={vs.title}>
      {' '}
      {diff > 0 ? '▲' : diff < 0 ? '▼' : '='} {diff > 0 ? '+' : diff < 0 ? '−' : ''}
      {Math.abs(diff)} п.п. {vs.label} <span className="muted">({prev}%)</span>
    </span>
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
  // Подписи дней — не чаще ~14 на график (длинный период).
  const every = Math.ceil(days.length / 14);
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
              {i % every === 0 && (
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
