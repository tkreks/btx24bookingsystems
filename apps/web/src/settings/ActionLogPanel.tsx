import { useDashboardQuery } from '../dashboard/DashboardSync.js';
import { useCallback, useState } from 'react';
import { ACTION_LOG_CATEGORIES, ACTION_LOG_CATEGORY_LABELS, ACTION_LOG_SEVERITIES, ACTION_LOG_SEVERITY_LABELS, classifyActionLog, todayIn, type ActionLogDto, type ActionLogEntryDto, type NamedBitrixItem } from '@btx24/shared';
import { apiGet } from '../api.js';
import { openCrm } from '../b24.js';
import { fmtDateTime, shiftDate } from '../format.js';

const ACTOR: Record<ActionLogEntryDto['actorKind'], string> = { user: '', system: 'система', bitrix: 'Битрикс24' };
const VIA: Record<string, string> = {
  CRM_DEAL_DETAIL_TAB: 'из сделки',
  DEFAULT: 'приложение',
  LEFT_MENU: 'меню',
  app: 'приложение',
  worker: 'автоматизация',
  reconcile: 'сверка',
};
const ENTITY: Record<string, string> = { deal: 'Сделка', booking: 'Бронь', chat: 'Чат', group: 'Группа', settings: 'Настройки' };

/** «сделка 678», «бронь 555», «678» → фильтр по объекту. */
export function parseEntity(q: string): { entityType?: string; entityId?: string } {
  const m = /^\s*(сделк[а-яё]*|deal|брон[а-яё]*|booking|чат[а-яё]*|chat)?\s*#?\s*(\d+)\s*$/i.exec(q);
  if (!m) return {};
  const word = (m[1] ?? '').toLowerCase();
  const type = /^(сделк|deal)/.test(word) ? 'deal' : /^(брон|booking)/.test(word) ? 'booking' : /^(чат|chat)/.test(word) ? 'chat' : undefined;
  return { ...(type ? { entityType: type } : {}), entityId: m[2] };
}

const show = (v: unknown) =>
  v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);

/**
 * ⚙ → «Журнал действий»: кто, что, когда и откуда — вход, правки «было → стало», брони, оплаты,
 * настройки, действия системы и Битрикс24. Новые сверху, по 5.
 */
export function ActionLogPanel({ timezone, users, period }: { timezone: string; users: NamedBitrixItem[]; period?: { from: string; to: string } }) {
  const today = todayIn(timezone);
  const [customFrom, setFrom] = useState(shiftDate(today, -6));
  const [customTo, setTo] = useState(today);
  const from = period?.from ?? customFrom;
  const to = period?.to ?? customTo;
  const [object, setObject] = useState('');
  const [text, setText] = useState('');
  const [who, setWho] = useState('');
  const [category, setCategory] = useState('');
  const [severity, setSeverity] = useState('');
  const [applied, setApplied] = useState({ object: '', text: '' });
  const [open, setOpen] = useState<string | null>(null);

  const ent = parseEntity(applied.object);
  const query = new URLSearchParams({
    from,
    to,
    ...(category ? { category } : {}),
    ...(severity ? { severity } : {}),
    ...(ent.entityType ? { entityType: ent.entityType } : {}),
    ...(ent.entityId ? { entityId: ent.entityId } : {}),
    // Объект не разобрался как «сделка 678» — ищем этот текст в описании.
    ...(applied.text || (applied.object && !ent.entityId) ? { q: applied.text || applied.object } : {}),
    ...(who === 'system' || who === 'bitrix' ? { actorKind: who } : who ? { userId: who } : {}),
  }).toString();

  const [page, setPage] = useState({ query, count: 5 });
  const count = page.query === query ? page.count : 5;
  const loader = useCallback(async (): Promise<ActionLogDto> => {
    const items: ActionLogEntryDto[] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams(query);
      params.set('limit', String(Math.min(100, count - items.length)));
      if (cursor) params.set('before', cursor);
      const result = await apiGet<ActionLogDto>(`/admin/action-log?${params}`);
      items.push(...result.items); cursor = result.nextCursor;
      if (!result.items.length) break;
    } while (cursor && items.length < count);
    return { items, nextCursor: cursor };
  }, [query, count]);
  const resource = useDashboardQuery<ActionLogDto>(`/admin/action-log?${query}&loaded=${count}`, loader);
  const [previous, setPrevious] = useState<{ query: string; data: ActionLogDto } | null>(null);
  if (resource.data && previous?.data !== resource.data) setPrevious({ query, data: resource.data });
  const data = resource.data ?? (previous?.query === query ? previous.data : null);
  const error = resource.error; const busy = resource.fetching && !resource.data;
  const rows = data?.items ?? null;

  return (
    <section className="action-log">
      <form
        className="action-log-filters"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied({ object, text });
        }}
      >
        {!period && <>
        <label>
          с <input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
        </label>
        <label>
          по <input type="date" value={to} min={from} max={today} onChange={(e) => e.target.value && setTo(e.target.value)} />
        </label>
        </>}
        <input aria-label="Объект" placeholder="сделка 678, бронь 555…" value={object} onChange={(e) => setObject(e.target.value)} />
        <select aria-label="Кто" value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="">Все</option>
          <option value="system">Система</option>
          <option value="bitrix">Битрикс24</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
        <select aria-label="Категория" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">Все категории</option>
          {ACTION_LOG_CATEGORIES.map((c) => <option key={c} value={c}>{ACTION_LOG_CATEGORY_LABELS[c]}</option>)}
        </select>
        <select aria-label="Критичность" value={severity} onChange={(e) => setSeverity(e.target.value)}>
          <option value="">Любая критичность</option>
          {ACTION_LOG_SEVERITIES.map((v) => <option key={v} value={v}>{ACTION_LOG_SEVERITY_LABELS[v]}</option>)}
        </select>
        <input aria-label="Поиск" placeholder="Текст: «снял», «оплата»…" value={text} onChange={(e) => setText(e.target.value)} />
        <button className="primary" type="submit">
          Найти
        </button>
      </form>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {!rows && !error && <p className="muted">Загрузка…</p>}
      {rows && !rows.length && <p className="muted">За период записей нет.</p>}
      {rows && rows.length > 0 && (
        <ol className="action-log-list">
          {rows.map((r) => {
            const changes = (r.details as { changes?: { label: string; before: unknown; after: unknown }[] } | null)?.changes;
            const expanded = open === r.id;
            const classification = r.category && r.severity ? r : classifyActionLog(r);
            return (
              <li key={r.id} data-dashboard-anchor={`log:${r.id}`} className={`action-log-row ${r.actorKind}`}>
                <button type="button" className="action-log-head" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : r.id)}>
                  <span className="action-log-time">{fmtDateTime(r.at, timezone)}</span>
                  <span className="action-log-who">
                    {r.actorName ?? '—'}
                    {ACTOR[r.actorKind] && <span className={`pill ${r.actorKind === 'system' ? 'waiting' : 'muted-pill'}`}>{ACTOR[r.actorKind]}</span>}
                  </span>
                  <span className="action-log-what"><span className="action-log-tags"><span className="audit-category">{ACTION_LOG_CATEGORY_LABELS[classification.category]}</span><span className={`audit-severity severity-${classification.severity}`} title="Критичность">{ACTION_LOG_SEVERITY_LABELS[classification.severity]}</span></span>{r.summary}</span>
                  <span className="action-log-via muted">{r.via ? (VIA[r.via] ?? r.via) : ''}</span>
                </button>
                {expanded && (
                  <div className="action-log-details">
                    {r.entityType && r.entityId && (
                      <p>
                        {ENTITY[r.entityType] ?? r.entityType} #{r.entityId}{' '}
                        {r.entityType === 'deal' && (
                          <button type="button" className="link" onClick={() => openCrm('deal', Number(r.entityId))}>
                            открыть в CRM
                          </button>
                        )}
                      </p>
                    )}
                    {changes && changes.length > 0 && (
                      <table className="action-log-changes">
                        <thead>
                          <tr>
                            <th>Поле</th>
                            <th>Было</th>
                            <th>Стало</th>
                          </tr>
                        </thead>
                        <tbody>
                          {changes.map((c, i) => (
                            <tr key={i}>
                              <td>{c.label}</td>
                              <td className="before">{show(c.before)}</td>
                              <td className="after">{show(c.after)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    <details>
                      <summary>Подробности ({r.action})</summary>
                      <pre>{JSON.stringify(r.details, null, 2)}</pre>
                    </details>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {data?.nextCursor && (
        <button type="button" disabled={busy} onClick={() => setPage({ query, count: count + 5 })}>
          {busy ? 'Загрузка…' : 'Показать ещё'}
        </button>
      )}
      <p className="muted dash-note">
        Журнал только пополняется — записи нельзя изменить или удалить. Пишутся входы в приложение, открытие и правка сделок
        («было → стало»), брони (создание, снятие сотрудником, снятие системой по неоплате, изменения и удаления в Битрикс24),
        оплаты, сообщения в чатах (без текста), настройки и все остальные изменения.
      </p>
    </section>
  );
}
