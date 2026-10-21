import { useEffect, useState } from 'react';
import { CALL_KIND_LABELS, type CallKind, type CallListDto, type CallScope } from '@btx24/shared';
import { apiGet } from '../api.js';
import { openCrm } from '../b24.js';
import { fmtDateTime } from '../format.js';

const OWNER: Record<number, { label: string; type: 'lead' | 'deal' | 'contact' | 'company' } | undefined> = {
  1: { label: 'Лид', type: 'lead' },
  2: { label: 'Сделка', type: 'deal' },
  3: { label: 'Контакт', type: 'contact' },
  4: { label: 'Компания', type: 'company' },
};

/** Окно со сделками (и другими элементами CRM), попавшими в выбранный вид звонков. */
export function CallsModal({
  kind,
  from,
  to,
  scope,
  timezone,
  onClose,
}: {
  kind: CallKind;
  from: string;
  to: string;
  scope: CallScope;
  timezone: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<CallListDto | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    apiGet<CallListDto>(`/dashboard/calls?kind=${kind}&from=${from}&to=${to}&scope=${scope}`).then(
      (d) => active && setData(d),
      (e) => active && setError(e instanceof Error ? e.message : 'Не удалось загрузить звонки'),
    );
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    return () => {
      active = false;
      document.removeEventListener('keydown', esc);
    };
  }, [kind, from, to, scope, onClose]);

  const deals = new Set(data?.items.filter((i) => i.dealId).map((i) => i.dealId));

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet calls-modal" role="dialog" aria-modal="true" aria-label={CALL_KIND_LABELS[kind]} onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>
            {CALL_KIND_LABELS[kind]} звонки
            {data && (
              <span className="muted">
                {' '}
                · {data.items.length}, сделок: {deals.size}
              </span>
            )}
          </h3>
          <button aria-label="Закрыть" onClick={onClose}>
            ×
          </button>
        </header>
        {kind === 'lost' && (
          <p className="muted">Пропущенные входящие, после которых клиенту не перезвонили и он сам не дозвонился. Один клиент — одна строка.</p>
        )}
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        {!data && !error && <p className="muted">Загрузка…</p>}
        {data && !data.items.length && <p className="muted">Звонков нет.</p>}
        {data?.truncated && <p className="notice">Звонков очень много — показаны не все. Сузьте период.</p>}
        <ul className="call-rows">
          {data?.items.map((c) => {
            const o = OWNER[c.owner.typeId];
            return (
              <li key={c.activityId}>
                <span className="muted">{fmtDateTime(c.at, timezone)}</span>
                <span className={`pill${c.missed ? ' waiting' : ''}`}>{c.missed ? 'пропущен' : 'отвечен'}</span>
                <span className="call-phone">{c.phone ?? '—'}</span>
                {o ? (
                  <button className="link" onClick={() => openCrm(o.type, c.owner.id)}>
                    {c.owner.title ?? `${o.label} #${c.owner.id}`}
                  </button>
                ) : (
                  <span className="muted">элемент CRM #{c.owner.id}</span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
