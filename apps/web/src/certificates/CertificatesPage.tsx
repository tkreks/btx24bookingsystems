import { useEffect, useState } from 'react';
import {
  CERTIFICATE_ACTION_LABELS,
  CERTIFICATE_STATUS_LABELS,
  todayIn,
  type CertificateDetailsDto,
  type CertificateDto,
  type CertificateListDto,
  type CertificateRedeemReason,
  type CertificateStatus,
  type IssueCertificateInput,
} from '@btx24/shared';
import { apiGet, apiPost, apiPut } from '../api.js';
import { openCrm } from '../b24.js';
import { fmtDateTime, fmtMoney, plusMonths } from '../format.js';
import { MinimizeButton } from '../Minimize.js';

type Filter = 'all' | CertificateStatus | 'overdue';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'Все' },
  { key: 'new', label: 'Новые' },
  { key: 'overdue', label: 'Срок прошёл' },
  { key: 'used', label: 'Использованы' },
  { key: 'expired', label: 'Истекли' },
];

/** «23.10.2026» из «2026-10-23». */
const ru = (d: string | null) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : '—');
const errorText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/**
 * Сертификаты: список с поиском и фильтром по статусу; выпуск, изменение срока действия и погашение
 * (использован / истёк) — у кого есть право (администраторы, сотрудники с правом приёма оплаты).
 * У нового сертификата с прошедшим сроком — отметка «срок прошёл»: погасить как «истёк».
 */
export function CertificatesPage({ timezone, onBack }: { timezone: string; onBack: () => void }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [data, setData] = useState<CertificateListDto | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [issuing, setIssuing] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  // Поиск — с паузой после ввода, чтобы не дёргать сервер на каждую букву.
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams({ ...(filter === 'all' ? {} : { status: filter }), ...(query ? { q: query } : {}) });
    apiGet<CertificateListDto>(`/certificates?${params}`).then(
      (d) => {
        if (!active) return;
        setData(d);
        setError('');
      },
      (e) => active && setError(errorText(e, 'Не удалось загрузить сертификаты')),
    );
    return () => {
      active = false;
    };
  }, [filter, query, revision]);

  const refresh = () => setRevision((n) => n + 1);

  return (
    <div className="page certificates-page">
      <header className="toolbar">
        <div className="toolbar-title">
          <button aria-label="Назад" onClick={onBack}>
            ‹
          </button>
          <h1>Сертификаты</h1>
          {data && <span className="muted">{data.counts.all}</span>}
        </div>
        <div className="toolbar-controls">
          {data?.canManage && (
            <button className="primary" onClick={() => setIssuing(true)}>
              + Выпустить сертификат
            </button>
          )}
        </div>
      </header>

      <div className="cert-filters">
        <div className="segmented" role="group" aria-label="Статус">
          {FILTERS.map((f) => (
            <button key={f.key} className={filter === f.key ? 'active' : ''} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.label}
              {data && <span className="cert-count">{data.counts[f.key]}</span>}
            </button>
          ))}
        </div>
        <input className="cert-search" type="search" placeholder="Номер или имя" aria-label="Поиск по номеру или имени" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {data && !data.canManage && <p className="muted dash-note">Выпускать и погашать сертификаты могут администраторы и сотрудники, принимающие оплату.</p>}

      <section className="day-panel cert-panel">
        {!data && !error && <p className="muted">Загрузка…</p>}
        {data && !data.items.length && <p className="muted">{query || filter !== 'all' ? 'Ничего не найдено.' : 'Сертификатов пока нет.'}</p>}
        {!!data?.items.length && (
          <div className="cert-table" role="table" aria-label="Сертификаты">
            <div className="cert-row cert-head" role="row">
              <span role="columnheader">Номер</span>
              <span role="columnheader">На чьё имя</span>
              <span role="columnheader" className="cert-num">
                Номинал
              </span>
              <span role="columnheader">Оплачен</span>
              <span role="columnheader">Действует до</span>
              <span role="columnheader">Статус</span>
            </div>
            {data.items.map((c) => (
              <button key={c.id} className={`cert-row${c.overdue ? ' overdue' : ''}`} role="row" onClick={() => setOpenId(c.id)}>
                <span role="cell" className="cert-number">
                  №{c.number}
                </span>
                <span role="cell" className="cert-holder">
                  {c.holderName}
                </span>
                <span role="cell" className="cert-num">
                  {fmtMoney(c.nominal, 'RUB')}
                </span>
                <span role="cell" className="muted">
                  {ru(c.paidOn)}
                </span>
                <span role="cell">{ru(c.validUntil)}</span>
                <span role="cell">
                  <StatusPill c={c} />
                </span>
              </button>
            ))}
          </div>
        )}
        {data?.truncated && <p className="muted dash-note">Показаны последние 500 — уточните поиск.</p>}
      </section>

      {issuing && (
        <IssueDialog
          timezone={timezone}
          onClose={() => setIssuing(false)}
          onIssued={(c) => {
            setIssuing(false);
            refresh();
            setOpenId(c.id);
          }}
        />
      )}
      {openId && <CertificateCard id={openId} timezone={timezone} canManage={!!data?.canManage} onClose={() => setOpenId(null)} onChanged={refresh} />}
    </div>
  );
}

function StatusPill({ c }: { c: CertificateDto }) {
  if (c.overdue)
    return (
      <span className="cert-status overdue" title="Срок действия прошёл — погасите как «истёк»">
        срок прошёл
      </span>
    );
  return <span className={`cert-status ${c.status}`}>{CERTIFICATE_STATUS_LABELS[c.status]}</span>;
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
}

/** Выпуск: номер (пусто — следующий), номинал, на чьё имя, дата оплаты, срок (по умолчанию — год). */
function IssueDialog({ timezone, onClose, onIssued }: { timezone: string; onClose: () => void; onIssued: (c: CertificateDetailsDto) => void }) {
  const today = todayIn(timezone);
  const [form, setForm] = useState({ number: '', nominal: '', holderName: '', paidOn: today, validUntil: plusMonths(today, 12), dealId: '', comment: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEscape(onClose);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const nominal = Number(form.nominal.replace(',', '.').replace(/\s/g, ''));
  const invalid = !form.holderName.trim() ? 'Укажите, на чьё имя сертификат' : !(nominal > 0) ? 'Укажите номинал' : !form.validUntil ? 'Укажите срок действия' : '';

  const submit = async () => {
    setBusy(true);
    setError('');
    const body: IssueCertificateInput = {
      ...(form.number.trim() ? { number: form.number.trim() } : {}),
      nominal,
      holderName: form.holderName.trim(),
      paidOn: form.paidOn || null,
      validUntil: form.validUntil,
      dealId: Number(form.dealId) > 0 ? Number(form.dealId) : null,
      comment: form.comment.trim() || null,
    };
    try {
      onIssued(await apiPost<CertificateDetailsDto>('/certificates', body));
    } catch (e) {
      setError(errorText(e, 'Не удалось выпустить сертификат'));
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={() => !busy && onClose()}>
      <form
        className="sheet cert-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Выпуск сертификата"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (!invalid) void submit();
        }}
      >
        <header>
          <h2>Выпуск сертификата</h2>
          <MinimizeButton label="Выпуск сертификата" />
          <button type="button" aria-label="Закрыть" disabled={busy} onClick={onClose}>
            ×
          </button>
        </header>
        <div className="cert-form">
          <label>
            Номер
            <input value={form.number} onChange={set('number')} placeholder="автоматически" maxLength={32} autoComplete="off" />
          </label>
          <label>
            Номинал, ₽
            <input value={form.nominal} onChange={set('nominal')} inputMode="decimal" placeholder="5 000" autoFocus required />
          </label>
          <label className="wide">
            На чьё имя
            <input value={form.holderName} onChange={set('holderName')} maxLength={255} placeholder="Имя и фамилия" required />
          </label>
          <label>
            Дата оплаты
            <input type="date" value={form.paidOn} max={today} onChange={set('paidOn')} />
          </label>
          <label>
            Действителен до
            <input type="date" value={form.validUntil} min={form.paidOn || undefined} onChange={set('validUntil')} required />
          </label>
          <div className="cert-presets wide" role="group" aria-label="Срок действия">
            {[3, 6, 12].map((m) => (
              <button type="button" key={m} className={form.validUntil === plusMonths(form.paidOn || today, m) ? 'active' : ''} onClick={() => setForm({ ...form, validUntil: plusMonths(form.paidOn || today, m) })}>
                {m === 12 ? '1 год' : `${m} мес.`}
              </button>
            ))}
          </div>
          <label>
            Сделка №
            <input value={form.dealId} onChange={set('dealId')} inputMode="numeric" placeholder="необязательно" />
          </label>
          <label className="wide">
            Комментарий
            <input value={form.comment} onChange={set('comment')} maxLength={1000} placeholder="необязательно" />
          </label>
        </div>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="submit" className="primary" disabled={busy || !!invalid} title={invalid || undefined}>
            {busy ? 'Выпуск…' : 'Выпустить'}
          </button>
          <button type="button" disabled={busy} onClick={onClose}>
            Отмена
          </button>
        </div>
      </form>
    </div>
  );
}

/** Карточка: данные, история и действия — изменить срок, погасить (использован / истёк). */
function CertificateCard({ id, timezone, canManage, onClose, onChanged }: { id: string; timezone: string; canManage: boolean; onClose: () => void; onChanged: () => void }) {
  const [c, setC] = useState<CertificateDetailsDto | null>(null);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'view' | 'change' | 'redeem'>('view');
  const [validUntil, setValidUntil] = useState('');
  const [reason, setReason] = useState<CertificateRedeemReason>('used');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  useEscape(onClose);

  useEffect(() => {
    apiGet<CertificateDetailsDto>(`/certificates/${id}`).then(setC, (e) => setError(errorText(e, 'Не удалось загрузить сертификат')));
  }, [id]);

  const start = (m: 'change' | 'redeem') => {
    setMode(m);
    setError('');
    setComment('');
    if (c) setValidUntil(c.validUntil);
    setReason(c?.overdue ? 'expired' : 'used');
  };
  const act = async (fn: () => Promise<CertificateDetailsDto>) => {
    setBusy(true);
    setError('');
    try {
      setC(await fn());
      setMode('view');
      onChanged();
    } catch (e) {
      setError(errorText(e, 'Не удалось выполнить действие'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={() => !busy && onClose()}>
      <div className="sheet cert-sheet" role="dialog" aria-modal="true" aria-label="Сертификат" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{c ? `Сертификат №${c.number}` : 'Сертификат'}</h2>
          <MinimizeButton label="Сертификат" />
          <button aria-label="Закрыть" disabled={busy} onClick={onClose}>
            ×
          </button>
        </header>
        {!c && !error && <p className="muted">Загрузка…</p>}
        {c && (
          <>
            <dl>
              <dt>Статус</dt>
              <dd>
                <StatusPill c={c} />
                {c.overdue && <span className="muted"> · действовал по {ru(c.validUntil)}</span>}
              </dd>
              <dt>Номинал</dt>
              <dd>
                <b>{fmtMoney(c.nominal, 'RUB')}</b>
              </dd>
              <dt>На чьё имя</dt>
              <dd>{c.holderName}</dd>
              <dt>Дата оплаты</dt>
              <dd>{ru(c.paidOn)}</dd>
              <dt>Действует до</dt>
              <dd>{ru(c.validUntil)} включительно</dd>
              {c.dealId && (
                <>
                  <dt>Сделка</dt>
                  <dd>
                    <button className="link" onClick={() => openCrm('deal', c.dealId!)}>
                      #{c.dealId}
                    </button>
                  </dd>
                </>
              )}
              {c.comment && (
                <>
                  <dt>Комментарий</dt>
                  <dd>{c.comment}</dd>
                </>
              )}
              {c.redeemedAt && (
                <>
                  <dt>Погашен</dt>
                  <dd>{fmtDateTime(c.redeemedAt, timezone)}</dd>
                </>
              )}
            </dl>

            {canManage && c.status === 'new' && mode === 'view' && (
              <div className="form-actions">
                <button onClick={() => start('change')}>Изменить срок</button>
                <button className="primary" onClick={() => start('redeem')}>
                  Погасить
                </button>
              </div>
            )}

            {mode === 'change' && (
              <form
                className="cert-action"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(() => apiPut<CertificateDetailsDto>(`/certificates/${c.id}`, { validUntil, comment: comment.trim() || null }));
                }}
              >
                <b>Изменение срока действия</b>
                <label>
                  Действителен до
                  <input type="date" value={validUntil} min={c.paidOn ?? undefined} onChange={(e) => setValidUntil(e.target.value)} required autoFocus />
                </label>
                <label>
                  Причина
                  <input value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} placeholder="необязательно" />
                </label>
                <div className="form-actions">
                  <button type="submit" className="primary" disabled={busy || !validUntil || validUntil === c.validUntil}>
                    Сохранить
                  </button>
                  <button type="button" disabled={busy} onClick={() => setMode('view')}>
                    Отмена
                  </button>
                </div>
              </form>
            )}

            {mode === 'redeem' && (
              <form
                className="cert-action"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(() => apiPost<CertificateDetailsDto>(`/certificates/${c.id}/redeem`, { reason, comment: comment.trim() || null }));
                }}
              >
                <b>Погашение сертификата</b>
                <div className="segmented" role="radiogroup" aria-label="Причина погашения">
                  {(['used', 'expired'] as const).map((r) => (
                    <button type="button" key={r} role="radio" aria-checked={reason === r} className={reason === r ? 'active' : ''} onClick={() => setReason(r)}>
                      {CERTIFICATE_STATUS_LABELS[r]}
                    </button>
                  ))}
                </div>
                <label>
                  Комментарий
                  <input value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} placeholder={reason === 'used' ? 'например, сделка или дата визита' : 'необязательно'} />
                </label>
                <p className="muted">После погашения сертификат нельзя изменить или погасить снова.</p>
                <div className="form-actions">
                  <button type="submit" className="primary" disabled={busy}>
                    Погасить: {CERTIFICATE_STATUS_LABELS[reason].toLowerCase()}
                  </button>
                  <button type="button" disabled={busy} onClick={() => setMode('view')}>
                    Отмена
                  </button>
                </div>
              </form>
            )}

            <h3 className="cert-history-title">История</h3>
            <ul className="cert-history">
              {c.events.map((e) => (
                <li key={e.id}>
                  <b>{CERTIFICATE_ACTION_LABELS[e.action]}</b>
                  <span>{e.text}</span>
                  <span className="muted">
                    {fmtDateTime(e.at, timezone)} · {e.userName}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
