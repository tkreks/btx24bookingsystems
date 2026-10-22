import { useEffect, useState } from 'react';
import { todayIn, type ActionLogDto, type ActionLogEntryDto, type NamedBitrixItem } from '@btx24/shared';
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
 * настройки, действия системы и Битрикс24. Новые сверху, по 100.
 */
export function ActionLogPanel({ timezone, users }: { timezone: string; users: NamedBitrixItem[] }) {
  const today = todayIn(timezone);
  const [from, setFrom] = useState(shiftDate(today, -6));
  const [to, setTo] = useState(today);
  const [object, setObject] = useState('');
  const [text, setText] = useState('');
  const [who, setWho] = useState('');
  const [applied, setApplied] = useState({ object: '', text: '' });
  const [data, setData] = useState<{ key: string; items: ActionLogEntryDto[]; next: string | null } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const ent = parseEntity(applied.object);
  const query = new URLSearchParams({
    from,
    to,
    ...(ent.entityType ? { entityType: ent.entityType } : {}),
    ...(ent.entityId ? { entityId: ent.entityId } : {}),
    // Объект не разобрался как «сделка 678» — ищем этот текст в описании.
    ...(applied.text || (applied.object && !ent.entityId) ? { q: applied.text || applied.object } : {}),
    ...(who === 'system' || who === 'bitrix' ? { actorKind: who } : who ? { userId: who } : {}),
  }).toString();

  // Первая страница — при смене фильтров; поздний ответ на старые фильтры отбрасывается.
  useEffect(() => {
    let active = true;
    apiGet<ActionLogDto>(`/admin/action-log?${query}`).then(
      (r) => {
        if (!active) return;
        setData({ key: query, items: r.items, next: r.nextCursor });
        setError('');
      },
      (e) => active && setError(e instanceof Error ? e.message : 'Не удалось загрузить журнал'),
    );
    return () => {
      active = false;
    };
  }, [query]);

  /** «Показать ещё» — следующая (более старая) страница. */
  const more = async (before: string) => {
    setBusy(true);
    try {
      const r = await apiGet<ActionLogDto>(`/admin/action-log?${query}&before=${before}`);
      setData((prev) => ({ key: query, items: prev?.key === query ? [...prev.items, ...r.items] : r.items, next: r.nextCursor }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить журнал');
    } finally {
      setBusy(false);
    }
  };

  const rows = data?.key === query ? data.items : null;

  return (
    <section className="action-log">
      <form
        className="action-log-filters"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied({ object, text });
        }}
      >
        <label>
          с <input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
        </label>
        <label>
          по <input type="date" value={to} min={from} max={today} onChange={(e) => e.target.value && setTo(e.target.value)} />
        </label>
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
            return (
              <li key={r.id} className={`action-log-row ${r.actorKind}`}>
                <button type="button" className="action-log-head" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : r.id)}>
                  <span className="action-log-time">{fmtDateTime(r.at, timezone)}</span>
                  <span className="action-log-who">
                    {r.actorName ?? '—'}
                    {ACTOR[r.actorKind] && <span className={`pill ${r.actorKind === 'system' ? 'waiting' : 'muted-pill'}`}>{ACTOR[r.actorKind]}</span>}
                  </span>
                  <span className="action-log-what">{r.summary}</span>
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
      {data?.next && data.key === query && (
        <button type="button" disabled={busy} onClick={() => void more(data.next!)}>
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
