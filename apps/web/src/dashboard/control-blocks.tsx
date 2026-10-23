import { useEffect, useState } from 'react';
import type { BookingAlertListDto, CertificateListDto, NeedsCloseDto, ResourceStopDto } from '@btx24/shared';
import { apiGet } from '../api.js';
import { openCrm } from '../b24.js';
import { fmtDateTime, fmtMoney } from '../format.js';
import { ListMore } from '../openlines/ListMore.js';
import { DashBadge } from '../openlines/RecentCalls.js';

/** Загрузка блока: данные, ошибка, «ещё грузится». */
function useLoad<T>(path: string | null, rev = 0): { data: T | null; error: string } {
  const [state, setState] = useState<{ key: string; data: T | null; error: string } | null>(null);
  const key = `${path}|${rev}`;
  useEffect(() => {
    if (!path) return;
    let active = true;
    apiGet<T>(path).then(
      (data) => active && setState({ key, data, error: '' }),
      (e) => active && setState({ key, data: null, error: e instanceof Error ? e.message : 'Не удалось загрузить' }),
    );
    return () => {
      active = false;
    };
  }, [path, key]);
  return state?.key === key ? state : { data: null, error: '' };
}

const ru = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const STEP = 5;

/** «Сделки к закрытию»: бронь прошла, а сделка в канбане ещё в работе — закрыть в Битрикс24. */
export function NeedsCloseBlock({ tz }: { tz: string }) {
  const { data, error } = useLoad<NeedsCloseDto>('/dashboard/needs-close');
  const [shown, setShown] = useState(STEP);
  const items = data?.items ?? [];
  return (
    <section className="day-panel dash-block">
      <DashBadge name="alert" />
      <p className="dash-attention-title muted">
        Сделки к закрытию
        {data && <span className={`pill${items.length ? ' waiting' : ''}`}>{items.length}</span>}
      </p>
      {!data && !error && <p className="muted">Загрузка…</p>}
      {error && <p className="muted">{error}</p>}
      {data && !items.length && <p className="muted">Все сделки с прошедшими бронями закрыты.</p>}
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
export function AlertsBlock({ onOpen }: { onOpen?: () => void }) {
  const { data, error } = useLoad<BookingAlertListDto>('/booking-alerts?status=new');
  const count = data?.counts.new ?? 0;
  return (
    <div className={`dash-tile${count ? ' warn' : ''}`}>
      <DashBadge name="alert" />
      <span className="dash-tile-label">Уведомления о бронях</span>
      <span className="dash-tile-value">{data ? count : error ? '—' : '…'}</span>
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
export function CertificatesBlock({ onOpen }: { onOpen?: () => void }) {
  const { data, error } = useLoad<CertificateListDto>('/certificates?status=overdue');
  return (
    <div className={`dash-tile${data?.counts.overdue ? ' warn' : ''}`}>
      <DashBadge name="calendar" />
      <span className="dash-tile-label">Сертификаты</span>
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
export function StopsBlock() {
  const { data, error } = useLoad<(ResourceStopDto & { resourceName: string })[]>('/resource-stops');
  return (
    <section className="day-panel dash-block">
      <DashBadge name="calendar" />
      <p className="dash-attention-title muted">
        Стопы ресурсов
        {data && <span className="pill">{data.length}</span>}
      </p>
      {!data && !error && <p className="muted">Загрузка…</p>}
      {error && <p className="muted">{error}</p>}
      {data && !data.length && <p className="muted">Все ресурсы открыты для бронирования.</p>}
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
