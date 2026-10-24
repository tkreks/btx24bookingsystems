import { ACTION_LOG_CATEGORY_LABELS, ACTION_LOG_SEVERITY_LABELS, type ClientTimelineEvent } from '@btx24/shared';
import { openCrm, openMessenger } from '../b24.js';
import { fmtDateTime, fmtMoney, shiftDate } from '../format.js';
import { Icon } from '../openlines/icons.js';
import { dayKey } from '../openlines/chat-list.js';

const EVENT_ICONS: Record<ClientTimelineEvent['kind'], string> = { message: '💬', call: '📞', deal: '🤝', booking: '📅', payment: '₽', invoice: '🧾', activity: '•' };

export function timelineDateLabel(date: string, timezone: string, now = new Date()): string {
  const today = dayKey(now.toISOString(), timezone);
  if (date === today) return 'Сегодня';
  if (date === shiftDate(today, -1)) return 'Вчера';
  return new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${date}T12:00:00Z`)).replace(/\s*г\.$/, '');
}

/** Не больше 100 символов, включая многоточие; не разрезаем emoji на суррогатные половины. */
export function messagePreview(text: string): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length > 100 ? chars.slice(0, 99).join('') + '…' : chars.join('');
}

function directionOf(e: ClientTimelineEvent): 'incoming' | 'outgoing' | null {
  return e.direction ?? (e.kind === 'call' ? e.title.startsWith('Исходящий') ? 'outgoing' : 'incoming' : e.kind === 'message' ? e.title.startsWith('Сообщение клиента') ? 'incoming' : 'outgoing' : null);
}
function DirectionTag({ e }: { e: ClientTimelineEvent }) {
  const d = directionOf(e);
  if (!d) return <span />;
  return <span className={`event-direction ${d}`}><Icon name={d === 'incoming' ? 'arrowDown' : 'arrowUp'} size={12} />{e.kind === 'message' ? d === 'incoming' ? 'вх.' : 'исх.' : d === 'incoming' ? 'Входящий' : 'Исходящий'}</span>;
}

export function ClientTimeline({ events, timezone, onOpenChat }: { events: ClientTimelineEvent[]; timezone: string; onOpenChat?: (chatId: number) => void }) {
  const groups = new Map<string, ClientTimelineEvent[]>();
  for (const e of events) {
    const date = dayKey(e.at, timezone);
    groups.set(date, [...(groups.get(date) ?? []), e]);
  }
  return <div className="client-timeline">{[...groups].map(([date, rows]) => <section className="client-event-day" key={date}>
    <h5>{timelineDateLabel(date, timezone)}</h5>
    <ol>{rows.map((e) => <li key={e.id} data-dashboard-anchor={`event:${e.id}`}>
      <details className={`client-event kind-${e.kind}`} data-event-id={e.id}>
        <summary>
          <span className="client-event-icon" aria-hidden="true">{EVENT_ICONS[e.kind]}</span>
          <span className="client-event-title" title={e.title}>{e.kind === 'call' ? 'Звонок' : e.kind === 'message' ? 'Сообщение' : e.title.replace(/\s*#\d+$/, '')}</span>
          <DirectionTag e={e} />
          <time dateTime={e.at}>{fmtDateTime(e.at, timezone)}</time>
          <span className="client-event-arrow" aria-hidden="true">⌄</span>
        </summary>
        <div className="client-event-body">
          {e.category && e.severity && <span className="action-log-tags"><span className="audit-category">{ACTION_LOG_CATEGORY_LABELS[e.category]}</span><span className={`audit-severity severity-${e.severity}`}>{ACTION_LOG_SEVERITY_LABELS[e.severity]}</span></span>}
          <span className="muted">Автор: {e.actorName || (e.actorId ? `Сотрудник #${e.actorId}` : 'Автор не указан')}</span>
          {e.text && (e.kind === 'message' ? <div className={`client-message ${directionOf(e)}`}><span className="client-message-sender">{e.actorName || 'Автор не указан'}</span><p>{messagePreview(e.text)}</p></div> : <p>{e.text}</p>)}
          {e.amount !== undefined && <strong>{fmtMoney(e.amount, e.currency ?? 'RUB')}</strong>}
          {(e.dealId || e.chatId) && <div className="row-actions">
            {e.dealId && <button type="button" className="link" onClick={() => openCrm('deal', e.dealId!)}>Сделка #{e.dealId}</button>}
            {e.chatId && <button type="button" className="link" onClick={() => onOpenChat ? onOpenChat(e.chatId!) : openMessenger(e.chatId!, e.messageId)}>Открыть чат</button>}
          </div>}
        </div>
      </details>
    </li>)}</ol>
  </section>)}</div>;
}
