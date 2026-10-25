import { useEffect, useState, type ReactNode } from 'react';
import type { DealOverviewDto, DealTimelineItemDto, DealTimelineKind } from '@btx24/shared';
import { apiGet } from '../api.js';
import { openCrm } from '../b24.js';
import { fmtDate, fmtDateTime, fmtMoney } from '../format.js';
import { Icon, type IconName } from '../openlines/icons.js';

const KIND: Record<DealTimelineKind, { icon: IconName; tone: string }> = {
  created: { icon: 'handshake', tone: 'ok' },
  stage: { icon: 'swap', tone: 'info' },
  call: { icon: 'phone', tone: 'info' },
  chat: { icon: 'chat', tone: 'info' },
  email: { icon: 'mail', tone: 'info' },
  meeting: { icon: 'people', tone: 'info' },
  task: { icon: 'clock', tone: 'warn' },
  activity: { icon: 'clock', tone: 'neutral' },
  comment: { icon: 'chats', tone: 'neutral' },
  app: { icon: 'layout', tone: 'app' },
};

/** Встройка сделки → «Сделка»: карточка сделки и таймлайн действий всех сотрудников по ней. */
export function DealOverviewPage({ dealId, timezone, onBack }: { dealId: number; timezone: string; onBack: () => void }) {
  const [data, setData] = useState<DealOverviewDto | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    apiGet<DealOverviewDto>(`/deals/${dealId}/overview`).then(
      (d) => alive && setData(d),
      (e) => alive && setError(e instanceof Error ? e.message : 'Не удалось загрузить сделку'),
    );
    return () => {
      alive = false;
    };
  }, [dealId]);
  const d = data?.deal;
  return (
    <div className="page deal-overview">
      <header className="deal-overview-head">
        <button type="button" className="cl-btn" aria-label="Назад" title="Назад" onClick={onBack}>
          <Icon name="back" size={21} />
        </button>
        <div className="deal-overview-heading">
          <h1>{d?.title ?? `Сделка #${dealId}`}</h1>
          <p className="muted">Сделка #{dealId}</p>
        </div>
        <button type="button" onClick={() => openCrm('deal', dealId)}>
          Открыть в CRM
        </button>
      </header>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {!data && !error && <p className="muted" role="status">Загрузка сделки…</p>}
      {data && d && (
        <>
          <section className="deal-facts" aria-label="Сделка">
            <Fact label="Стадия">
              {d.stage ? <span className={`deal-stage ${d.stage.semantics === 'S' ? 'won' : d.stage.semantics === 'F' ? 'lost' : 'work'}`}>{d.stage.name}</span> : '—'}
            </Fact>
            <Fact label="Сумма">{d.opportunity !== null ? fmtMoney(d.opportunity, d.currency) : '—'}</Fact>
            <Fact label="Клиент">
              {data.contact ? (
                <button type="button" className="link" onClick={() => openCrm('contact', data.contact!.id)}>
                  {data.contact.name || `Контакт #${data.contact.id}`}
                </button>
              ) : (
                '—'
              )}
              {!!data.contact?.phones.length && <span className="muted deal-fact-sub">{data.contact.phones.join(', ')}</span>}
            </Fact>
            <Fact label="Ответственный">{d.assigned?.name ?? '—'}</Fact>
            <Fact label="Создана">{d.createdAt ? fmtDate(d.createdAt, timezone) : '—'}</Fact>
          </section>
          <section className="deal-timeline" aria-label="Действия по сделке">
            <h2>Действия по сделке</h2>
            {!data.timeline.length && <p className="muted">Действий пока нет.</p>}
            <ol>
              {data.timeline.map((t) => (
                <TimelineItem key={t.id} t={t} timezone={timezone} />
              ))}
            </ol>
          </section>
        </>
      )}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="deal-fact">
      <span className="deal-fact-label">{label}</span>
      <span className="deal-fact-value">{children}</span>
    </div>
  );
}

function TimelineItem({ t, timezone }: { t: DealTimelineItemDto; timezone: string }) {
  const k = KIND[t.kind];
  return (
    <li className="deal-tl-item">
      <span className={`deal-tl-icon ${k.tone}`} aria-hidden="true">
        <Icon name={k.icon} size={15} />
      </span>
      <div className="deal-tl-body">
        <div className="deal-tl-head">
          <b>{t.title}</b>
          {t.direction && <span className="muted">{t.direction === 'in' ? 'входящий' : 'исходящий'}</span>}
          <time className="muted">{fmtDateTime(t.at, timezone)}</time>
        </div>
        {t.text && <p className="deal-tl-text">{t.text}</p>}
        <span className="deal-tl-actor muted">{t.actor ? t.actor.name : 'Система'}</span>
      </div>
    </li>
  );
}
