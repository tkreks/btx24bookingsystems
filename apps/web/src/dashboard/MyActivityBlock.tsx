import { BlockLoading } from './BlockLoading.js';
import { useState } from 'react';
import type { MyActivityDto } from '@btx24/shared';
import { useDashboardQuery } from './DashboardSync.js';
import { ClientTimeline } from '../calls/ClientTimeline.js';
import { DashBadge } from '../openlines/RecentCalls.js';

/** Сервер определяет сотрудника из аутентификации: никакого переключателя «Все». */
export function MyActivityBlock({ period, timezone, onOpenChat }: { period: { from: string; to: string }; timezone: string; onOpenChat: (chatId: number) => void }) {
  const key = `${period.from}|${period.to}`;
  const { data, error } = useDashboardQuery<MyActivityDto>(`/dashboard/my-activity?from=${period.from}&to=${period.to}`);
  const [page, setPage] = useState({ key, count: 5 });
  const count = page.key === key ? page.count : 5;

  return <section className="day-panel dash-block my-activity-block">
    <DashBadge name="history" />
    <p className="dash-attention-title muted">Журнал моих действий{data && <span className="pill">{data.events.length}</span>}</p>
    {error && <p className="notice error" role="alert">{error}</p>}
    {!data && !error && <BlockLoading rows={4} />}
    {data && !data.events.length && <p className="muted">За выбранный период ваших действий нет.</p>}
    {data && <ClientTimeline events={data.events.slice(0, count)} timezone={timezone} onOpenChat={onOpenChat} />}
    {data && count < data.events.length && <button type="button" className="list-more" onClick={() => setPage({ key, count: count + 5 })}>Показать ещё · {Math.min(count, data.events.length)} из {data.events.length}</button>}
    {data?.notes.map((note) => <p className="muted dash-note" key={note}>{note}</p>)}
  </section>;
}
