import type { ContactAlertListDto } from '@btx24/shared';
import { BlockLoading } from './BlockLoading.js';
import { useState } from 'react';
import type { GroupDirectoryDto, DashboardGapsDto, BookingAlertListDto, CertificateListDto, NeedsCloseDto, ResourceStopDto } from '@btx24/shared';
import { ActionLogPanel } from '../settings/ActionLogPanel.js';
import { useDashboardQuery } from './DashboardSync.js';
import { openCrm } from '../b24.js';
import { fmtDateTime, fmtMoney } from '../format.js';
import { ListMore } from '../openlines/ListMore.js';
import { MessengerSearchButton } from '../messengers/MessengerSearchButton.js';
import { Icon } from '../openlines/icons.js';
import { DashBadge } from '../openlines/RecentCalls.js';

/** Загрузка блока: данные, ошибка, «ещё грузится». */
function useLoad<T>(path: string | null, rev = 0): { data: T | null; error: string } {
  const resource = useDashboardQuery<T>(path ? `${path}${path.includes('?') ? '&' : '?'}_revision=${rev}` : null);
  return { data: resource.data, error: resource.error };
}

const ru = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const STEP = 5;
type Period = { from: string; to: string };
const periodQuery = (p: Period) => `from=${p.from}&to=${p.to}`;

/** «Сделки к закрытию»: бронь прошла, а сделка в канбане ещё в работе — закрыть в Битрикс24. */
export function NeedsCloseBlock({ tz }: { tz: string }) {
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const { data, error } = useLoad<NeedsCloseDto>(`/dashboard/needs-close?scope=${scope}`);
  const [shown, setShown] = useState(STEP);
  const items = data?.items ?? [];
  return (
    <section className="day-panel dash-block">
      <DashBadge name="alert" />
      <p className="dash-attention-title muted">
        Сделки к закрытию
        {data && <span className={`pill${items.length ? ' waiting' : ''}`}>{items.length}</span>}
      </p>
      <p className="muted dash-period-note">Завершённые брони · сделки ещё в работе</p>
      <div className="segmented needs-close-scope" role="group" aria-label="Ответственный за сделки к закрытию">
        <button type="button" className={scope === 'mine' ? 'active' : ''} aria-pressed={scope === 'mine'} onClick={() => { setScope('mine'); setShown(STEP); }}>Мои <span className="needs-close-count">{data?.counts.mine ?? '…'}</span></button>
        <button type="button" className={scope === 'all' ? 'active' : ''} aria-pressed={scope === 'all'} onClick={() => { setScope('all'); setShown(STEP); }}>Все <span className="needs-close-count">{data?.counts.all ?? '…'}</span></button>
      </div>
      {!data && !error && <BlockLoading />}
      {error && <p className="muted">{error}</p>}
      {data && !items.length && <p className="muted">Сделок к закрытию нет.</p>}
      <ul className="dt-rows">
        {items.slice(0, shown).map((i) => (
          <li key={i.dealId}>
            <button className="dt-row" onClick={() => openCrm('deal', i.dealId)} title="Бронь прошла — закройте сделку в Битрикс24">
              <span className="dt-main">
                <b>{i.title}</b>
                <span className="muted">
                  {i.client || 'без клиента'} · бронь до {fmtDateTime(i.bookingEnd, tz)}
                </span>
              </span>
              <span className="dt-side">
                <span className="deal-close">
                  <b aria-hidden="true">!</b> закрыть
                </span>
                {i.opportunity ? <span className="muted">{fmtMoney(i.opportunity, i.currency)}</span> : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <ListMore total={items.length} shown={shown} step={STEP} onShow={setShown} />
    </section>
  );
}

/** «Уведомления о бронях»: сколько новых и последние — открыть страницу уведомлений. */
export function AlertsBlock({ onOpen, period }: { onOpen?: () => void; period: Period }) {
  const { data, error } = useLoad<BookingAlertListDto>(`/booking-alerts?status=new&${periodQuery(period)}`);
  const { data: contacts } = useLoad<ContactAlertListDto>(`/contact-alerts?status=new&${periodQuery(period)}`);
  const count = (data?.counts.new ?? 0) + (contacts?.counts.new ?? 0);
  return (
    <div className={`dash-tile${count ? ' warn' : ''}`}>
      <DashBadge name="alert" />
      <span className="dash-tile-label">Уведомления</span>
      <span className="dash-tile-value">{data ? count : error ? '—' : '…'}</span>
      {!!contacts?.counts.new && <span className="dash-tile-hint">Контакты: {contacts.counts.new}</span>}
      {data?.items[0] && <span className="dash-tile-hint">последнее: {data.items[0].title ?? `бронь #${data.items[0].bookingId}`}</span>}
      {onOpen && (
        <button className="dash-tile-action" onClick={onOpen}>
          Открыть
        </button>
      )}
    </div>
  );
}

/** «Сертификаты»: новые и с прошедшим сроком (погасить как «истёк»). */
export function CertificatesBlock({ onOpen, period }: { onOpen?: () => void; period: Period }) {
  const { data, error } = useLoad<CertificateListDto>(`/certificates?status=overdue&${periodQuery(period)}`);
  return (
    <div className={`dash-tile${data?.counts.overdue ? ' warn' : ''}`}>
      <DashBadge name="calendar" />
      <span className="dash-tile-label">Сертификаты периода</span>
      <span className="muted dash-period-note">По дате выпуска · состояние на сейчас</span>
      <span className="dash-tile-value">
        {data ? data.counts.new : error ? '—' : '…'}
        <small> новых</small>
      </span>
      {data && (
        <span className="dash-tile-hint">
          срок прошёл: <b>{data.counts.overdue}</b>
          {data.items[0] ? ` · №${data.items[0].number} (${data.items[0].holderName})` : ''}
        </span>
      )}
      {onOpen && (
        <button className="dash-tile-action" onClick={onOpen}>
          Открыть
        </button>
      )}
    </div>
  );
}

/** «Стопы ресурсов»: действующие и будущие стопы ресурсов моих групп. */
export function StopsBlock({ period }: { period: Period }) {
  const { data, error } = useLoad<(ResourceStopDto & { resourceName: string })[]>(`/resource-stops?${periodQuery(period)}`);
  return (
    <section className="day-panel dash-block">
      <DashBadge name="calendar" />
      <p className="dash-attention-title muted">
        Стопы ресурсов
        {data && <span className="pill">{data.length}</span>}
      </p>
      {!data && !error && <BlockLoading />}
      {error && <p className="muted">{error}</p>}
      {data && !data.length && <p className="muted">В выбранном периоде стопов ресурсов нет.</p>}
      <ul className="dt-rows">
        {data?.map((s) => (
          <li key={s.id}>
            <div className="dt-row stop-row">
              <span className="dt-main">
                <b>🛑 {s.resourceName}</b>
                <span className="muted">
                  {s.reason} · {s.createdBy}
                </span>
              </span>
              <span className="dt-side">
                <span>
                  {ru(s.from)}
                  {s.to !== s.from ? ` — ${ru(s.to)}` : ''}
                </span>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}


export function DealGapsBlock({ kind, tz, period, onOpenChat }: { kind: 'chat' | 'contact'; tz: string; period: Period; onOpenChat?: (chatId: number) => void }) {
  const { data, error } = useLoad<DashboardGapsDto>(`/dashboard/deal-gaps?kind=${kind}&${periodQuery(period)}`);
  const [shown, setShown] = useState(STEP);
  return <section className="day-panel dash-block">
    <DashBadge name={kind === 'chat' ? 'chats' : 'person'} />
    <p className="dash-attention-title muted">{kind === 'chat' ? 'Сделки без открытой линии' : 'Сделки без контакта'}{data && <span className="pill">{data.items.length}</span>}</p>
    {!data && (error ? <p className="muted">{error}</p> : <BlockLoading />)}
    {data && !data.items.length && <p className="muted">Таких открытых сделок не найдено.</p>}
    <p className="muted dash-period-note">Созданы в выбранном периоде · состояние на сейчас</p>
    <ul className="dt-rows">{data?.items.slice(0, shown).map((d) => <li key={d.dealId} className="deal-gap-row">
      <button type="button" className="dt-row" onClick={() => openCrm('deal', d.dealId)}>
        <span className="dt-main"><b>{d.title}</b><span className="muted">#{d.dealId}{d.createdAt ? ` · ${fmtDateTime(d.createdAt, tz)}` : ''}</span></span>
        <span className="dt-side">{d.opportunity != null && fmtMoney(d.opportunity, d.currency)}</span>
      </button>
      {kind === 'chat' && <DealMessengerAction phones={d.phones ?? []} timezone={tz} onOpenChat={onOpenChat} />}
    </li>)}</ul>
    <ListMore total={data?.items.length ?? 0} shown={shown} step={STEP} onShow={setShown} />
    {data?.notes.map((note) => <p className="muted" key={note}>{note}</p>)}
  </section>;
}


function DealMessengerAction({ phones, timezone, onOpenChat }: { phones: string[]; timezone: string; onOpenChat?: (chatId: number) => void }) {
  const [selected, setSelected] = useState('');
  const phone = phones.includes(selected) ? selected : phones[0];
  if (!phone) return <button type="button" className="dash-icon-btn" disabled title="У клиента нет доступного телефона в CRM" aria-label="Поиск в мессенджерах: нет телефона клиента"><Icon name="search" size={18} /></button>;
  return <span className="deal-gap-messenger">
    {phones.length > 1 && <select aria-label="Телефон клиента для поиска в мессенджерах" value={phone} onChange={e => setSelected(e.target.value)}>{phones.map(p => <option key={p} value={p}>+{p}</option>)}</select>}
    <MessengerSearchButton key={phone} phone={phone} timezone={timezone} onOpenChat={onOpenChat} />
  </span>;
}


export function ActionLogBlock({ tz, period }: { tz: string; period: Period }) {
  const { data: directory } = useLoad<GroupDirectoryDto>('/admin/group-directory');
  return <section className="day-panel dash-block dashboard-action-log">
    <DashBadge name="history" />
    <p className="dash-attention-title muted">Журнал действий</p>
    <ActionLogPanel timezone={tz} users={directory?.users ?? []} period={period} />
  </section>;
}
