import { BlockLoading } from './BlockLoading.js';
import type { DashboardBlockType, HeadDashboardDto, HeadDayDto, HeadTotalsDto } from '@btx24/shared';
import { DashBadge } from '../openlines/RecentCalls.js';

/**
 * Блоки «по дням и сравнение» (бывший дашборд руководителя, решение владельца 2026-10-24): плитки с
 * прошлым периодом той же длины и графики по дням. Данные — `GET /api/head-dashboard` за период дашборда.
 */
export type HeadBlockType = Extract<DashboardBlockType, 'headNewDeals' | 'headBookedDeals' | 'headRepeat' | 'headCalls' | 'headMissed' | 'headLost' | 'dealsChart' | 'callsChart'>;
export const HEAD_BLOCKS: readonly HeadBlockType[] = ['headNewDeals', 'headBookedDeals', 'headRepeat', 'headCalls', 'headMissed', 'headLost', 'dealsChart', 'callsChart'];

/** Подпись сравнения по периоду дашборда. */
export function versus(preset: string, d: HeadDashboardDto | null, fmtDay: (date: string) => string): { label: string; title: string } {
  return {
    label: preset === 'today' ? 'ко вчера' : preset === 'yesterday' ? 'к позавчера' : 'к прошлому периоду',
    title: d?.previous ? `Прошлый период: ${d.previous.from === d.previous.to ? fmtDay(d.previous.from) : `${fmtDay(d.previous.from)} — ${fmtDay(d.previous.to)}`}` : '',
  };
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');

/** Один блок «по дням и сравнение». */
export function HeadBlock({ type, d, vs, word, periodText, tz }: { type: HeadBlockType; d: HeadDashboardDto | null; vs: { label: string; title: string }; word: string; periodText: string; tz: string }) {
  const p = d?.previous?.totals;
  const n = (v: number | undefined, ok = true) => (!d ? '…' : ok ? String(v ?? 0) : '—');
  const t = d?.totals;
  switch (type) {
    case 'headNewDeals':
      return (
        <div className={`dash-tile${p && d?.deals ? toneClass(d.totals.newDeals, p.newDeals) : ''}`}>
          <DashBadge name="person" />
          <span className="dash-tile-label">Новых сделок {word} · все воронки</span>
          <span className="dash-tile-value">{n(t?.newDeals, d?.deals)}</span>
          {p && d?.deals && <Trend cur={d.totals.newDeals} prev={p.newDeals} vs={vs} />}
          <span className="dash-tile-hint">в воронках всех групп</span>
        </div>
      );
    case 'headBookedDeals':
      return (
        <div className={`dash-tile${p && d?.deals ? toneClass(conv(d.totals), conv(p)) : ''}`}>
          <DashBadge name="calendar" />
          <span className="dash-tile-label">Бронирований по новым сделкам</span>
          <span className="dash-tile-value">
            {n(t?.bookings, d?.deals)}
            {d?.deals && <small> · сделок с бронью {d.totals.bookedDeals}</small>}
          </span>
          <span className="dash-tile-hint">
            конверсия в бронь: {d ? pct(d.totals.bookedDeals, d.totals.newDeals) : '…'}
            {p && d?.deals && <ConvTrend cur={conv(d.totals)} prev={conv(p)} vs={vs} />}
          </span>
        </div>
      );
    case 'headRepeat':
      return (
        <div className="dash-tile">
          <DashBadge name="people" />
          <span className="dash-tile-label">Сделки повторных клиентов</span>
          <span className="dash-tile-value">{n(t?.repeat, d?.deals)}</span>
          <span className="dash-tile-hint">у клиента раньше была бронь (состоялась)</span>
        </div>
      );
    case 'headCalls':
      return (
        <div className={`dash-tile${p && d?.calls ? toneClass(d.totals.calls, p.calls) : ''}`}>
          <DashBadge name="phone" />
          <span className="dash-tile-label">Звонков {word}</span>
          <span className="dash-tile-value">{n(t?.calls, d?.calls)}</span>
          {p && d?.calls && <Trend cur={d.totals.calls} prev={p.calls} vs={vs} />}
          {d?.calls && (
            <span className="dash-tile-hint">
              входящих {d.totals.incoming} · исходящих {d.totals.outgoing}
            </span>
          )}
        </div>
      );
    case 'headMissed':
      return (
        <div className={`dash-tile${p && d?.calls ? toneClass(d.totals.missed, p.missed, true) : ''}`}>
          <DashBadge name="phone" />
          <span className="dash-tile-label">Пропущенных</span>
          <span className="dash-tile-value">{n(t?.missed, d?.calls)}</span>
          {p && d?.calls && <Trend cur={d.totals.missed} prev={p.missed} vs={vs} lowerIsBetter />}
          <span className="dash-tile-hint">входящие без ответа</span>
        </div>
      );
    case 'headLost':
      return (
        <div className={`dash-tile${p && d?.calls ? toneClass(d.totals.lost, p.lost, true) : ''}`}>
          <DashBadge name="alert" />
          <span className="dash-tile-label">Упущенных клиентов</span>
          <span className="dash-tile-value">{n(t?.lost, d?.calls)}</span>
          {p && d?.calls && <Trend cur={d.totals.lost} prev={p.lost} vs={vs} lowerIsBetter />}
          <span className="dash-tile-hint">нет успешного звонка или диалога в чате</span>
        </div>
      );
    case 'dealsChart':
      return (
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
      );
    case 'callsChart':
      return (
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
      );
  }
}

/** Конверсия новых сделок в бронь, целые %; сделок нет — null. */
export const conv = (t: HeadTotalsDto) => (t.newDeals ? Math.round((t.bookedDeals / t.newDeals) * 100) : null);

/**
 * Рамка плитки по сравнению с прошлым периодом: лучше — зелёная, хуже — красная, так же — без рамки.
 * `lowerIsBetter` — для пропущенных и упущенных. Конверсия без сделок в одном из периодов — без рамки.
 */
export function toneClass(cur: number | null, prev: number | null, lowerIsBetter = false): string {
  if (cur === null || prev === null || cur === prev) return '';
  return (cur > prev) !== lowerIsBetter ? ' trend-good' : ' trend-bad';
}

/** «▲ +12% ко вчера (25)»; прошлый период пуст — «▲ +4 ко вчера (0)». */
export function Trend({ cur, prev, vs, lowerIsBetter = false }: { cur: number; prev: number; vs: { label: string; title: string }; lowerIsBetter?: boolean }) {
  const diff = cur - prev;
  const tone = diff === 0 ? 'same' : (diff > 0) !== lowerIsBetter ? 'good' : 'bad';
  const text = diff === 0 ? '0%' : prev ? `${diff > 0 ? '+' : '−'}${Math.round((Math.abs(diff) / prev) * 100)}%` : `${diff > 0 ? '+' : '−'}${Math.abs(diff)}`;
  return (
    <span className={`trend ${tone}`} title={`${vs.title}. Зелёный — лучше прошлого периода, красный — хуже`}>
      {diff > 0 ? '▲' : diff < 0 ? '▼' : '='} {text} {vs.label} <span className="muted">({prev})</span>
    </span>
  );
}

/** Конверсия: разница в процентных пунктах с прошлым периодом. */
export function ConvTrend({ cur, prev, vs }: { cur: number | null; prev: number | null; vs: { label: string; title: string } }) {
  if (cur === null || prev === null) return <span className="trend same" title={`${vs.title}. Зелёный — лучше прошлого периода, красный — хуже`}> · {vs.label}: {prev === null ? 'сделок не было' : `${prev}%`}</span>;
  const diff = cur - prev;
  const tone = diff === 0 ? 'same' : diff > 0 ? 'good' : 'bad';
  return (
    <span className={`trend ${tone}`} title={`${vs.title}. Зелёный — лучше прошлого периода, красный — хуже`}>
      {' '}
      {diff > 0 ? '▲' : diff < 0 ? '▼' : '='} {diff > 0 ? '+' : diff < 0 ? '−' : ''}
      {Math.abs(diff)} п.п. {vs.label} <span className="muted">({prev}%)</span>
    </span>
  );
}

type SeriesKey = keyof Omit<HeadDayDto, 'date'>;

/** Столбцы по дням: несколько показателей рядом; подписи дней снизу, значения — в подсказке. */
export function BarChart({ days, series, tz }: { days: HeadDayDto[] | null; series: { key: SeriesKey; label: string; color: string }[]; tz: string }) {
  if (!days) return <BlockLoading rows={2} />;
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
