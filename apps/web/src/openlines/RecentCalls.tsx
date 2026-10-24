import { MessengerSearchDialog } from '../messengers/MessengerSearchDialog.js';
import { BlockLoading } from '../dashboard/BlockLoading.js';
import { ColorLegend, type LegendItem } from '../ColorLegend.js';
import { useState } from 'react';
import { type CallLogRowDto, type CallScope, type RecentCallsDto, todayIn } from '@btx24/shared';
import { useDashboardQuery } from '../dashboard/DashboardSync.js';
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

/** Цвет трубки — вид звонка (те же переменные темы, что у строк). */
const CALL_LEGEND: LegendItem[] = [
  { label: 'входящий', swatch: { background: 'var(--ok-text)' } },
  { label: 'исходящий', swatch: { background: 'var(--status-work-text)' } },
  { label: 'не дозвонились', swatch: { background: 'var(--status-wait-text)' }, title: 'Исходящий — клиент не ответил' },
  { label: 'пропущенный / упущенный', swatch: { background: 'var(--status-fail-text)' }, title: 'Упущенный — не перезвонили и не ответили в чате' },
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
 * длительность разговора; время слева от кнопок: сегодня — ЧЧ:ММ, вчера — с подписью, иначе с датой. Кнопки — последняя сделка и чат клиента внутри приложения.
 */
export function RecentCalls({ scope, timezone, from, to, onOpenChat }: { scope: CallScope; timezone: string; from: string; to: string; onOpenChat: (chatId: number) => void }) {
  const { data, error } = useDashboardQuery<RecentCallsDto>(`/dashboard/recent-calls?scope=${scope}&from=${from}&to=${to}`);
  const key = `${scope}|${from}|${to}`;
  const [searchPhone, setSearchPhone] = useState<string | null>(null);
  // «Показать ещё» — в пределах выбранных «Все / Мои» и периода; смена — снова 5.
  const [more, setMore] = useState({ key, n: STEP });
  const shown = more.key === key ? more.n : STEP;


  const items = data ? [...data.items].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.activityId - a.activityId) : null;
  return (
    <section className="day-panel dash-block dash-recent-calls">
      <DashBadge name="phone" />
      <p className="dash-attention-title muted">Звонки</p>
      <ColorLegend items={CALL_LEGEND} label="Цвета звонков" className="block" />
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
                  {c.latestDealId && <button type="button" className="dash-icon-btn" aria-label="Открыть сделку" title="Последняя созданная сделка клиента" onClick={() => openCrm('deal', c.latestDealId!)}><Icon name="handshake" size={18} /></button>}
                  {!c.latestChatId && c.clientPhone && <button type="button" className="dash-icon-btn" aria-label="Поиск в мессенджерах" title="Найти клиента в доступных мессенджерах" onClick={() => setSearchPhone(c.clientPhone!)}><Icon name="mail" size={18} /></button>}
                  {c.latestChatId && <button type="button" className="dash-icon-btn" aria-label="Перейти в чат" title="Чат клиента с последней активностью" onClick={() => onOpenChat(c.latestChatId!)}><Icon name="chat" size={18} /></button>}
                </span>
              </div>
            </li>
          );
        })}
      </ul></div>
      {searchPhone && <MessengerSearchDialog phone={searchPhone} timezone={timezone} onClose={() => setSearchPhone(null)} onOpenChat={onOpenChat} />}
      {items && <ListMore total={items.length} shown={shown} step={STEP} onShow={(n) => setMore({ key, n })} />}
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
