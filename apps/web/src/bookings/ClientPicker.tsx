import { useEffect, useState } from 'react';
import type { CrmContactHit, CrmDealHit, CrmSearchDto } from '@btx24/shared';
import { apiGet, apiPost } from '../api.js';
import { fmtMoney } from '../format.js';
import { Avatar } from '../openlines/Avatar.js';

type Kind = 'contact' | 'deal';

/** «Имя Фамилия» и номер контакта — надстрочным тегом. */
export function ContactName({ name, id }: { name: string; id: number }) {
  return (
    <span className="contact-name">
      <b>{name}</b>
      <sup className="contact-id">#{id}</sup>
    </span>
  );
}

/**
 * Поиск клиента или сделки для брони: «Клиент» — ID контакта, телефон, e-mail или ФИО; «Сделка» —
 * название, ID или имя клиента. Поиск — от 2 символов, с паузой после ввода. В мастере — в окне
 * (карандаш у клиента, «Найти сделку»); нового клиента создаёт `NewClientForm`.
 */
export function ClientPicker({
  onContact,
  onDeal,
  initialKind = 'contact',
  autoFocus = false,
}: {
  onContact: (c: CrmContactHit) => void;
  onDeal: (d: CrmDealHit) => void;
  initialKind?: Kind;
  autoFocus?: boolean;
}) {
  const [kind, setKind] = useState<Kind>(initialKind);
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
                  <button type="button" role="option" aria-selected={false} className="cp-contact" onClick={() => onContact(c)}>
                    <Avatar src={c.photo} name={c.name} size={36} />
                    <span className="cp-contact-main">
                      <ContactName name={c.name} id={c.id} />
                      {(c.phones[0] || c.emails[0]) && (
                        <span className="muted cp-contact-comms">
                          {c.phones[0] && <span>📞 {c.phones[0]}</span>}
                          {c.emails[0] && <span>✉ {c.emails[0]}</span>}
                        </span>
                      )}
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

/**
 * «＋ Добавить» клиента: имя и телефон; контакт с этим номером уже есть — берётся он (`POST /crm/contacts`).
 */
export function NewClientForm({ name = null, onContact, onCancel }: { name?: string | null; onContact: (c: CrmContactHit) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState({ name: name ?? '', phone: '', busy: false, error: '' });
  const create = async () => {
    if (draft.busy || !draft.name.trim()) return;
    setDraft({ ...draft, busy: true, error: '' });
    try {
      onContact(await apiPost<CrmContactHit>('/crm/contacts', { name: draft.name.trim(), phone: draft.phone.trim() || undefined }));
    } catch (e) {
      setDraft({ ...draft, busy: false, error: e instanceof Error ? e.message : 'Не удалось создать клиента' });
    }
  };
  return (
    <div
      className="cp-new-form"
      role="group"
      aria-label="Новый клиент"
      onKeyDown={(e) => {
        if (e.key !== 'Enter' || (e.target as HTMLElement).tagName !== 'INPUT') return;
        e.preventDefault();
        void create();
      }}
    >
      <label className="df-field">
        <span className="df-label">
          Имя и фамилия<i className="df-req">*</i>
        </span>
        <input value={draft.name} maxLength={100} autoFocus onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
      </label>
      <label className="df-field">
        <span className="df-label">Телефон</span>
        <input value={draft.phone} inputMode="tel" placeholder="+7…" onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
      </label>
      <p className="cp-hint">Клиент с этим телефоном уже есть в CRM — выберем его, нового не создадим.</p>
      {draft.error && <p className="cp-hint error">{draft.error}</p>}
      <div className="wz-time-actions">
        <button type="button" onClick={onCancel}>
          Отмена
        </button>
        <button type="button" className="primary" disabled={draft.busy || !draft.name.trim()} onClick={() => void create()}>
          {draft.busy ? 'Создаём…' : 'Создать'}
        </button>
      </div>
    </div>
  );
}
