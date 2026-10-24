import { useState } from 'react';
import { createPortal } from 'react-dom';
import {
  KPI_GRID_SIZES,
  KPI_METRIC_LABELS,
  KPI_METRICS,
  normalizeKpiGrid,
  type CallKind,
  type CallListDto,
  type CallScope,
  type DashboardDto,
  type KpiGridConfig,
  type KpiMetric,
} from '@btx24/shared';
import { apiGet } from '../api.js';
import { DashBadge } from '../openlines/RecentCalls.js';
import { DealKanban, type KanbanExtra } from './DealKanban.js';

const CALL_METRIC: Partial<Record<KpiMetric, CallKind>> = { callsIncoming: 'incoming', callsNew: 'new', callsAnswered: 'answered', callsMissed: 'missed', callsLost: 'lost' };

type Opened = { title: string; dealIds: number[]; extra: KanbanExtra[] };

/** Число показателя и сделки за ним (звонки — сделки клиентов загружаются по нажатию). */
function metricOf(m: KpiMetric, d: Partial<DashboardDto> | null): { value: number | null | undefined; dealIds?: number[] } {
  const ids = (xs: { dealId?: number | null; id?: number }[] | undefined) => (xs ?? []).map((x) => x.dealId ?? x.id ?? 0).filter((x) => x > 0);
  switch (m) {
    case 'newDeals':
      return { value: d?.newDeals === undefined ? undefined : (d.newDeals?.total ?? null), dealIds: ids(d?.newDeals?.items) };
    case 'repeatDeals':
      return { value: d?.newDeals === undefined ? undefined : (d.newDeals?.repeat ?? null), dealIds: ids(d?.newDeals?.items.filter((x) => x.repeat)) };
    case 'paidDeals':
      return { value: d?.paidDeals === undefined ? undefined : (d.paidDeals?.total ?? null), dealIds: ids(d?.paidDeals?.items) };
    case 'bookingsToday':
      return { value: d?.bookingDays?.today, dealIds: ids(d?.bookingDays?.todayItems) };
    case 'bookingsTomorrow':
      return { value: d?.bookingDays?.tomorrow, dealIds: ids(d?.bookingDays?.tomorrowItems) };
    case 'newBookings':
      return { value: d?.bookings?.created.total, dealIds: ids(d?.bookings?.created.items) };
    case 'removedBookings':
      return { value: d?.bookings?.removed.total, dealIds: ids(d?.bookings?.removed.items) };
    default: {
      const kind = CALL_METRIC[m]!;
      return { value: d?.calls === undefined ? undefined : (d.calls?.[kind] ?? null) };
    }
  }
}

/**
 * «Показатели (таблица)»: до 6 чисел дашборда за период в таблице 1–3 × 1–3 (настройка — ⚙ в блоке).
 * Нажатие на число — отдельное окно с канбаном сделок за ним, как в Битрикс24.
 */
export function KpiGridBlock({
  config,
  d,
  calls,
  timezone,
  onConfigure,
}: {
  config: KpiGridConfig | undefined;
  d: Partial<DashboardDto> | null;
  calls: { from: string; to: string; scope: CallScope; funnel: number | null };
  timezone: string;
  onConfigure: (next: KpiGridConfig) => void;
}) {
  const grid = normalizeKpiGrid(config);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [loading, setLoading] = useState<KpiMetric | null>(null);
  const [error, setError] = useState('');
  const [setup, setSetup] = useState(false);

  const open = (m: KpiMetric) => {
    setError('');
    const kind = CALL_METRIC[m];
    if (!kind) return setOpened({ title: KPI_METRIC_LABELS[m], dealIds: metricOf(m, d).dealIds ?? [], extra: [] });
    setLoading(m);
    apiGet<CallListDto>(`/dashboard/calls?kind=${kind}&from=${calls.from}&to=${calls.to}&scope=${calls.scope}${calls.funnel === null ? '' : `&funnel=${calls.funnel}`}`)
      .then(
        (r) =>
          setOpened({
            title: KPI_METRIC_LABELS[m],
            dealIds: r.items.map((c) => c.dealId ?? 0).filter((x) => x > 0),
            extra: r.items.filter((c) => !c.dealId).map((c) => ({ key: c.clientKey, title: c.contact?.name || c.owner.title || c.phone || 'Клиент', subtitle: c.phone, at: c.at })),
          }),
        (e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить звонки'),
      )
      .finally(() => setLoading(null));
  };

  return (
    <section className="day-panel dash-block dash-kpi-grid">
      <DashBadge name="layout" />
      <p className="dash-attention-title muted">
        Показатели
        <button type="button" className="dash-kpi-setup" aria-label="Настроить таблицу показателей" title="Настроить: размер и показатели" onClick={() => setSetup(true)}>
          ⚙
        </button>
      </p>
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="kpi-grid" style={{ gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))` }}>
        {grid.items.map((m, i) => {
          const { value } = metricOf(m, d);
          const text = value === undefined ? '…' : value === null ? '—' : String(value);
          return (
            <button key={`${i}:${m}`} type="button" className={`kpi-cell kpi-${m}`} disabled={value === undefined || value === null || loading !== null} title="Показать сделки канбаном" onClick={() => open(m)}>
              <span className="kpi-value">{loading === m ? '…' : text}</span>
              <span className="kpi-label">{KPI_METRIC_LABELS[m]}</span>
            </button>
          );
        })}
      </div>
      {opened && <DealKanban title={opened.title} dealIds={opened.dealIds} extra={opened.extra} extraTitle="Без сделки" timezone={timezone} onClose={() => setOpened(null)} />}
      {setup && <KpiSetup value={grid} onClose={() => setSetup(false)} onSave={(next) => { setSetup(false); onConfigure(next); }} />}
    </section>
  );
}

/** Настройка таблицы: размер (столбцы × строки, до 6 ячеек) и показатель в каждой ячейке. */
function KpiSetup({ value, onSave, onClose }: { value: KpiGridConfig; onSave: (v: KpiGridConfig) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(value);
  const resize = (cols: 1 | 2 | 3, rows: 1 | 2 | 3) => setDraft(normalizeKpiGrid({ cols, rows, items: draft.items }));
  return createPortal(
    <div className="sheet-backdrop" onClick={onClose}>
      <form className="sheet kpi-setup" role="dialog" aria-modal="true" aria-label="Таблица показателей" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); onSave(draft); }}>
        <header>
          <h2>Таблица показателей</h2>
          <button type="button" aria-label="Закрыть" onClick={onClose}>×</button>
        </header>
        <p className="muted">Размер: столбцы × строки</p>
        <div className="segmented kpi-sizes" role="radiogroup" aria-label="Размер таблицы">
          {KPI_GRID_SIZES.map((s) => (
            <button key={`${s.cols}x${s.rows}`} type="button" role="radio" aria-checked={draft.cols === s.cols && draft.rows === s.rows} className={draft.cols === s.cols && draft.rows === s.rows ? 'active' : ''} onClick={() => resize(s.cols, s.rows)}>
              {s.cols}×{s.rows}
            </button>
          ))}
        </div>
        <div className="kpi-grid kpi-grid-setup" style={{ gridTemplateColumns: `repeat(${draft.cols}, minmax(0, 1fr))` }}>
          {draft.items.map((m, i) => (
            <label key={i} className="kpi-cell">
              <span className="kpi-label">Ячейка {i + 1}</span>
              <select value={m} onChange={(e) => setDraft({ ...draft, items: draft.items.map((x, j) => (j === i ? (e.target.value as KpiMetric) : x)) })}>
                {KPI_METRICS.map((k) => (
                  <option key={k} value={k}>
                    {KPI_METRIC_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        <footer className="sheet-actions">
          <button type="button" onClick={onClose}>Отмена</button>
          <button type="submit" className="primary">Сохранить</button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}
