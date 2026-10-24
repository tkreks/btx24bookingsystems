import { MessengerSearchButton } from '../messengers/MessengerSearchButton.js';
import { BlockLoading } from '../dashboard/BlockLoading.js';
import { useState } from 'react';
import { type CallLogRowDto, type CallScope, type RecentCallsDto, todayIn } from '@btx24/shared';
import { useDashboardQuery, useDashboardRefreshAll } from '../dashboard/DashboardSync.js';
import { apiPost } from '../api.js';
import { openCrm } from '../b24.js';
import { fmtTime, fmtDate, fmtDateTime, shiftDate } from '../format.js';
import { Avatar } from './Avatar.js';
import { Icon } from './icons.js';
import { ListMore } from './ListMore.js';

/** Сколько звонков показывать сразу и сколько добавляет «Показать ещё». */
const STEP = 5;

/** Цвет строки: входящий — зелёный, исходящий — голубой, исходящий без ответа — жёлтый, пропущенный — красный. */
export function callTone(c: Pick<CallLogRowDto, 'direction' | 'status' | 'lost'>): 'in' | 'out' | 'noanswer' | 'missed' | 'lost' {
  if (c.lost) return 'lost';
  if (c.status === 'missed') return 'missed';
  if (c.status === 'no_answer') return 'noanswer';
  return c.direction === 'incoming' ? 'in' : 'out';
}

type CallTone = ReturnType<typeof callTone>;

/** Цвет трубки — вид звонка (те же переменные темы, что у строк); упущенные — отдельной категорией. */
const CALL_LEGEND: { tone: CallTone; label: string; title?: string }[] = [
  { tone: 'in', label: 'входящие' },
  { tone: 'out', label: 'исходящие' },
  { tone: 'noanswer', label: 'не дозвонились', title: 'Исходящий — клиент не ответил' },
  { tone: 'missed', label: 'пропущенные', title: 'Входящий без ответа — перезвонили или ответили в чате' },
  { tone: 'lost', label: 'упущенные', title: 'Пропущенный, а клиенту не перезвонили и не ответили в чате' },
];

export function callTypeLabel(c: Pick<CallLogRowDto, 'direction' | 'status' | 'lost'>): string {
  return c.lost ? 'Упущенный' : c.status === 'missed' ? 'Пропущенный' : c.direction === 'incoming' ? 'Входящий' : 'Исходящий';
}

export function callTypeIcon(c: Pick<CallLogRowDto, 'direction' | 'status' | 'lost'>) {
  return c.lost ? 'callLost' : c.status === 'missed' ? 'close' : c.direction === 'incoming' ? 'arrowDown' : 'arrowUp';
}

/** Единицы отличают длительность разговора от времени начала справа. */
export function callDurationText(seconds: number): string {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0;
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value % 3600 / 60);
  const rest = value % 60;
  return [hours ? `${hours} ч` : '', minutes ? `${minutes} мин` : '', rest || (!hours && !minutes) ? `${rest} с` : ''].filter(Boolean).join(' ');
}

/** Подпись зависит от выбранного периода; дата и «сегодня» — в часовом поясе портала. */
export function callTimeText(at: string, timezone: string, from: string, to: string, now = new Date()): string {
  const today = todayIn(timezone, now);
  const time = fmtTime(at, timezone);
  if (from === to && from === today) return time;
  if (from === to && from === shiftDate(today, -1)) return `вчера ${time}`;
  return `${fmtDate(at, timezone)} ${time}`;
}

/**
 * Блок «Звонки» на дашборде: последние звонки периода дашборда из журнала звонков (дела CRM), к
 * которым у сотрудника есть доступ, — по 5, «Показать ещё». Цвет — по направлению и статусу,
 * длительность разговора; цвета — только те, что есть за период, нажатие на цвет оставляет только эту
 * категорию (ещё раз — все); время слева от кнопок: сегодня — ЧЧ:ММ, вчера — с подписью, иначе с датой. Кнопки — последняя сделка и чат клиента внутри приложения.
 */
export function RecentCalls({ scope, timezone, from, to, onOpenChat, total, canExclude = false }: { scope: CallScope; timezone: string; from: string; to: string; onOpenChat: (chatId: number) => void; total?: number | null; canExclude?: boolean }) {
  const [excluding, setExcluding] = useState<CallLogRowDto | null>(null);
  const { data, error } = useDashboardQuery<RecentCallsDto>(`/dashboard/recent-calls?scope=${scope}&from=${from}&to=${to}`);
  const [filter, setFilter] = useState<{ key: string; tone: CallTone } | null>(null);
  const base = `${scope}|${from}|${to}`;
  // Смена «Все / Мои» или периода — снова все категории.
  const tone = filter?.key === base ? filter.tone : null;
  const key = `${base}|${tone ?? ''}`;
  // «Показать ещё» — в пределах выбранных «Все / Мои» и периода; смена — снова 5.
  const [more, setMore] = useState({ key, n: STEP });
  const shown = more.key === key ? more.n : STEP;


  const all = data ? [...data.items].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.activityId - a.activityId) : null;
  const counts = new Map<CallTone, number>();
  for (const c of all ?? []) counts.set(callTone(c), (counts.get(callTone(c)) ?? 0) + 1);
  const items = all && tone ? all.filter((c) => callTone(c) === tone) : all;
  const legend = CALL_LEGEND.filter((l) => counts.has(l.tone));
  return (
    <section className="day-panel dash-block dash-recent-calls">
      <DashBadge name="phone" />
      <p className="dash-attention-title muted">
        Звонки
        {/* Всего за период (по «Все / Мои»), а не только загруженные в блок последние. */}
        {(total ?? all?.length) != null && <span className="pill" title="Всего звонков за период">{total ?? all!.length}</span>}
      </p>
      {legend.length > 0 && (
        <div className="color-legend block call-filter" role="group" aria-label="Категории звонков: показать только выбранную">
          {legend.map((l) => (
            <button
              key={l.tone}
              type="button"
              className={`call-filter-item ${l.tone}${tone === l.tone ? ' active' : ''}`}
              aria-pressed={tone === l.tone}
              title={tone === l.tone ? 'Показать все звонки' : (l.title ?? `Показать только: ${l.label}`)}
              onClick={() => setFilter(tone === l.tone ? null : { key: base, tone: l.tone })}
            >
              <i aria-hidden="true" />
              {l.label}
              <span className="call-filter-count">{counts.get(l.tone)}</span>
            </button>
          ))}
        </div>
      )}
      {error && <p className="muted">{error}</p>}
      {!items && !error && <BlockLoading rows={4} />}
      {items && !items.length && <p className="muted">Звонков за период нет.</p>}
      <div className="call-inline-scroll" tabIndex={0} role="region" aria-label="Звонки: кто звонил, тип, кому, время"><ul className="dt-rows">
        {items?.slice(0, shown).map((c) => {
          const clientName = c.contact?.name || ([1,3,4].includes(c.owner.typeId) ? c.owner.title : null) || 'Клиент';
          const employeeName = c.employee?.name || 'Менеджер не указан';
          const tone = callTone(c);
          const label = c.status === 'no_answer' ? 'Исходящий — клиент не ответил' : callTypeLabel(c);
          return (
            <li key={c.activityId} data-dashboard-anchor={`call:${c.activityId}`}>
              <div className={`dt-row call-inline call-tone-${tone}`}>
                <span className={`call-inline-type ${tone}`} role="img" aria-label={label} title={label}><Icon name="phone" size={18} /><Icon name={callTypeIcon(c)} size={18} /></span>
                <span className="call-party"><Avatar src={c.clientAvatar || c.contact?.photo} name={clientName} size={24} /><span className="call-party-name" title={clientName}>{clientName}</span></span>

                <span className="call-inline-duration" title="Длительность разговора">{callDurationText(c.durationSec)}</span>
                <span className="call-party"><Avatar src={c.employee?.photo} name={employeeName} size={24} /><span className="call-party-name" title={employeeName}>{employeeName}</span></span>
                <time className="attention-time call-inline-time" dateTime={c.at} title={fmtDateTime(c.at, timezone)}>{callTimeText(c.at, timezone, from, to)}</time>
                <span className="call-inline-actions">
                  {canExclude && (tone === 'missed' || tone === 'lost') && <button type="button" className="dash-icon-btn" aria-label="Исключить из статистики" title="Исключить из статистики (внутренний тест, ошибочный звонок)" onClick={() => setExcluding(c)}><Icon name="close" size={16} /></button>}
                  {c.latestDealId && <button type="button" className="dash-icon-btn" aria-label="Открыть сделку" title="Последняя созданная сделка клиента" onClick={() => openCrm('deal', c.latestDealId!)}><Icon name="handshake" size={18} /></button>}
                  {!c.latestChatId && c.clientPhone && <MessengerSearchButton phone={c.clientPhone} timezone={timezone} onOpenChat={onOpenChat} />}
                  {c.latestChatId && <button type="button" className="dash-icon-btn" aria-label="Перейти в чат" title="Чат клиента с последней активностью" onClick={() => onOpenChat(c.latestChatId!)}><Icon name="chat" size={18} /></button>}
                </span>
              </div>
            </li>
          );
        })}
      </ul></div>
      {items && <ListMore total={items.length} shown={shown} step={STEP} onShow={(n) => setMore({ key, n })} />}
      {excluding && <ExcludeCallDialog call={excluding} timezone={timezone} onClose={() => setExcluding(null)} />}
    </section>
  );
}

/** Иконка блока дашборда — в углу блока, а не у текста. */
export function DashBadge({ name }: { name: Parameters<typeof Icon>[0]['name'] }) {
  return (
    <span className="dash-badge" aria-hidden="true">
      <Icon name={name} size={20} />
    </span>
  );
}

/** Исключить звонок из статистики (только администратор приложения): причина обязательна. */
function ExcludeCallDialog({ call, timezone, onClose }: { call: CallLogRowDto; timezone: string; onClose: () => void }) {
  const [reason, setReason] = useState('Внутренний тест');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refreshAll = useDashboardRefreshAll();
  const name = call.contact?.name || call.clientPhone || 'клиент';
  const submit = () => {
    setBusy(true);
    setError('');
    apiPost(`/dashboard/calls/${call.activityId}/exclude`, { reason }).then(
      () => {
        refreshAll();
        onClose();
      },
      (e) => {
        setError(e instanceof Error ? e.message : 'Не получилось');
        setBusy(false);
      },
    );
  };
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <form className="sheet exclude-call" role="dialog" aria-modal="true" aria-label="Исключить звонок из статистики" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <header>
          <h2>Исключить звонок из статистики</h2>
          <button type="button" aria-label="Закрыть" onClick={onClose}>×</button>
        </header>
        <p>
          {callTypeLabel(call)} от «{name}», {fmtDateTime(call.at, timezone)}. Звонок не будет считаться в показателях, упущенных и
          списках звонков. В Битрикс24 он не меняется.
        </p>
        <label className="field">
          Причина
          <input value={reason} maxLength={500} required autoFocus onChange={(e) => setReason(e.target.value)} />
        </label>
        {error && <p className="notice error" role="alert">{error}</p>}
        <footer className="sheet-actions">
          <button type="button" onClick={onClose}>Отмена</button>
          <button type="submit" className="primary" disabled={busy || !reason.trim()}>Исключить</button>
        </footer>
      </form>
    </div>
  );
}
