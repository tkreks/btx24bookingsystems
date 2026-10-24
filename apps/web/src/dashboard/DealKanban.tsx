import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DealKanbanDto, KanbanDealDto, KanbanStageDto } from '@btx24/shared';
import { apiGet } from '../api.js';
import { openCrm } from '../b24.js';
import { fmtDate, fmtMoney } from '../format.js';
import { Avatar } from '../openlines/Avatar.js';

/** Карточка без сделки (звонок клиента, к которому сделки нет) — отдельной колонкой в конце. */
export interface KanbanExtra {
  key: string;
  title: string;
  subtitle: string | null;
  at: string | null;
}

/**
 * Канбан сделок по числу показателя — как канбан Битрикс24: колонки-стадии в порядке воронки, в
 * заголовке — число и сумма, карточки сделок. Только просмотр (переносить нельзя); по карточке —
 * сделка в Битрикс24. Пустые стадии свёрнуты, их можно показать.
 */
export function DealKanban({ title, dealIds, extra = [], extraTitle = 'Без сделки', timezone, onClose }: { title: string; dealIds: number[]; extra?: KanbanExtra[]; extraTitle?: string; timezone: string; onClose: () => void }) {
  const ids = [...new Set(dealIds)].join(',');
  // Без сделок (только звонки без сделки) — сразу, без запроса.
  const [data, setData] = useState<DealKanbanDto | null>(() => (ids ? null : { funnels: [], deals: [], hidden: 0 }));
  const [error, setError] = useState('');
  const [empty, setEmpty] = useState(false);

  useEffect(() => {
    let active = true;
    if (!ids) return;
    apiGet<DealKanbanDto>(`/dashboard/deal-kanban?ids=${ids}`).then(
      (d) => active && setData(d),
      (e) => active && setError(e instanceof Error ? e.message : 'Не удалось загрузить сделки'),
    );
    return () => void (active = false);
  }, [ids]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);

  const total = (data?.deals.length ?? 0) + extra.length;
  return createPortal(
    <div className="sheet-backdrop kanban-backdrop" onClick={onClose}>
      <div className="sheet kanban-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>
            {title} {data && <span className="pill">{total}</span>}
          </h2>
          <label className="kanban-empty-toggle">
            <input type="checkbox" checked={empty} onChange={(e) => setEmpty(e.target.checked)} /> пустые стадии
          </label>
          <button type="button" aria-label="Закрыть" onClick={onClose}>
            ×
          </button>
        </header>
        {error && <p className="notice error" role="alert">{error}</p>}
        {!data && !error && <p className="muted">Загружаем сделки…</p>}
        {data && !total && <p className="muted">Сделок нет.</p>}
        {!!data?.hidden && <p className="muted kanban-note">Ещё {data.hidden} — нет доступа в CRM или сделка удалена.</p>}
        {data?.funnels.map((f) => {
          const deals = data.deals.filter((d) => d.categoryId === f.id);
          const known = new Set(f.stages.map((s) => s.id));
          // Стадия, которой нет в справочнике (удалили), — в конце, чтобы сделка не пропала.
          const stray = [...new Set(deals.filter((d) => !known.has(d.stageId)).map((d) => d.stageId))].map((id): KanbanStageDto => ({ id, name: id, color: null, semantics: 'process' }));
          const stages = [...f.stages, ...stray];
          return (
            <section key={f.id} className="kanban-funnel" aria-label={`Воронка «${f.name}»`}>
              {data.funnels.length > 1 && <h3 className="kanban-funnel-name">{f.name}</h3>}
              <div className="kanban-board" role="list">
                {stages.map((s) => {
                  const list = deals.filter((d) => d.stageId === s.id);
                  if (!list.length && !empty) return null;
                  return <Column key={s.id} stage={s} deals={list} timezone={timezone} />;
                })}
                {extra.length > 0 && f.id === data.funnels[data.funnels.length - 1].id && <ExtraColumn title={extraTitle} items={extra} timezone={timezone} />}
              </div>
            </section>
          );
        })}
        {data && !data.funnels.length && extra.length > 0 && (
          <div className="kanban-board" role="list">
            <ExtraColumn title={extraTitle} items={extra} timezone={timezone} />
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function sumOf(deals: KanbanDealDto[]): string {
  const byCurrency = new Map<string, number>();
  for (const d of deals) if (d.opportunity) byCurrency.set(d.currency ?? 'RUB', (byCurrency.get(d.currency ?? 'RUB') ?? 0) + d.opportunity);
  return [...byCurrency].map(([c, v]) => fmtMoney(v, c)).join(' + ') || fmtMoney(0, 'RUB');
}

function Column({ stage, deals, timezone }: { stage: KanbanStageDto; deals: KanbanDealDto[]; timezone: string }) {
  const color = stage.color || (stage.semantics === 'success' ? '#7bd500' : stage.semantics === 'failure' ? '#ff5752' : '#39a8ef');
  return (
    <div className={`kanban-col${deals.length ? '' : ' empty'}`} role="listitem" aria-label={`${stage.name}: ${deals.length}`}>
      <div className="kanban-col-head" style={{ ['--stage' as string]: color }}>
        <span className="kanban-col-name" title={stage.name}>{stage.name}</span>
        <span className="kanban-col-count">({deals.length})</span>
      </div>
      <div className="kanban-col-sum">{sumOf(deals)}</div>
      <div className="kanban-cards">
        {deals.map((d) => (
          <button key={d.id} type="button" className="kanban-card" title="Открыть сделку в Битрикс24" onClick={() => openCrm('deal', d.id)}>
            <span className="kanban-card-title">{d.title}</span>
            {d.opportunity !== null && <span className="kanban-card-sum">{fmtMoney(d.opportunity, d.currency)}</span>}
            {d.contact && <span className="kanban-card-client">{d.contact.name || `Контакт #${d.contact.id}`}</span>}
            <span className="kanban-card-foot">
              <span className="muted">{d.createdAt ? fmtDate(d.createdAt, timezone) : ''}</span>
              {d.assigned && <Avatar src={d.assigned.photo} name={d.assigned.name || `Сотрудник ${d.assigned.id}`} size={24} />}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ExtraColumn({ title, items, timezone }: { title: string; items: KanbanExtra[]; timezone: string }) {
  return (
    <div className="kanban-col kanban-col-extra" role="listitem" aria-label={`${title}: ${items.length}`}>
      <div className="kanban-col-head" style={{ ['--stage' as string]: 'var(--muted)' }}>
        <span className="kanban-col-name">{title}</span>
        <span className="kanban-col-count">({items.length})</span>
      </div>
      <div className="kanban-col-sum">&nbsp;</div>
      <div className="kanban-cards">
        {items.map((x) => (
          <div key={x.key} className="kanban-card static">
            <span className="kanban-card-title">{x.title}</span>
            {x.subtitle && <span className="kanban-card-client">{x.subtitle}</span>}
            <span className="kanban-card-foot">
              <span className="muted">{x.at ? fmtDate(x.at, timezone) : ''}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
