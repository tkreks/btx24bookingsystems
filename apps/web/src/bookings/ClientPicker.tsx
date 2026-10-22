import { useEffect, useState } from 'react';
import type { CrmContactHit, CrmDealHit, CrmSearchDto } from '@btx24/shared';
import { apiGet } from '../api.js';
import { fmtMoney } from '../format.js';

type Kind = 'contact' | 'deal';

/**
 * Поиск клиента или сделки для брони: «Клиент» — ID контакта, телефон, e-mail или ФИО; «Сделка» —
 * название, ID или имя клиента. Поиск — от 2 символов, с паузой после ввода.
 */
export function ClientPicker({
  onContact,
  onDeal,
  autoFocus = false,
}: {
  onContact: (c: CrmContactHit) => void;
  onDeal: (d: CrmDealHit) => void;
  autoFocus?: boolean;
}) {
  const [kind, setKind] = useState<Kind>('contact');
  const [q, setQ] = useState('');
  const [res, setRes] = useState<{ key: string; data: CrmSearchDto | null; error: string } | null>(null);
  const query = q.trim();
  const key = `${kind}:${query}`;

  useEffect(() => {
    if (query.length < 2) return;
    let active = true;
    const timer = setTimeout(() => {
      apiGet<CrmSearchDto>(`/crm/search?kind=${kind}&q=${encodeURIComponent(query)}`).then(
        (data) => active && setRes({ key, data, error: '' }),
        (e) => active && setRes({ key, data: null, error: e instanceof Error ? e.message : 'Поиск не удался' }),
      );
    }, 350);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [kind, query, key]);

  const current = res?.key === key ? res : null;
  const hits = kind === 'contact' ? (current?.data?.contacts ?? []) : (current?.data?.deals ?? []);

  return (
    <div className="cp">
      <div className="cp-bar">
        <div className="wz-seg cp-kind" role="group" aria-label="Что ищем">
          {(
            [
              ['contact', 'Клиент'],
              ['deal', 'Сделка'],
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" className={kind === k ? 'active' : ''} aria-pressed={kind === k} onClick={() => setKind(k)}>
              {label}
            </button>
          ))}
        </div>
        <input
          type="search"
          aria-label={kind === 'contact' ? 'Поиск клиента' : 'Поиск сделки'}
          placeholder={kind === 'contact' ? 'Телефон, e-mail, ФИО или ID контакта' : 'Название сделки, имя клиента или ID'}
          value={q}
          autoFocus={autoFocus}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {query.length > 0 && query.length < 2 && <p className="cp-hint">Введите хотя бы 2 символа</p>}
      {query.length >= 2 && !current && <p className="cp-hint">Ищем…</p>}
      {current?.error && <p className="cp-hint error">{current.error}</p>}
      {current?.data && !hits.length && <p className="cp-hint">Ничего не найдено</p>}
      {hits.length > 0 && (
        <ul className="cp-hits" role="listbox" aria-label="Результаты поиска">
          {kind === 'contact'
            ? (hits as CrmContactHit[]).map((c) => (
                <li key={c.id}>
                  <button type="button" role="option" aria-selected={false} onClick={() => onContact(c)}>
                    <b>{c.name}</b>
                    <span className="muted">
                      #{c.id}
                      {c.phones[0] ? ` · ${c.phones[0]}` : ''}
                      {c.emails[0] ? ` · ${c.emails[0]}` : ''}
                    </span>
                  </button>
                </li>
              ))
            : (hits as CrmDealHit[]).map((d) => (
                <li key={d.id}>
                  <button type="button" role="option" aria-selected={false} onClick={() => onDeal(d)}>
                    <b>{d.title}</b>
                    <span className="muted">
                      #{d.id}
                      {d.contact?.name ? ` · ${d.contact.name}` : ''}
                      {d.opportunity ? ` · ${fmtMoney(d.opportunity, d.currency)}` : ''}
                      {d.closed ? ' · закрыта' : ''}
                    </span>
                  </button>
                </li>
              ))}
        </ul>
      )}
    </div>
  );
}
