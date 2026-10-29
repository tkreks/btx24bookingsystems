import { useState } from 'react';
import type { ContactAlertDto } from '@btx24/shared';
import { openCrm } from '../b24.js';
import { fmtDateTime } from '../format.js';
import { CHANGES_SHOWN, contactSeverity, fieldValue, realChanges, SEVERITY_LABELS } from './notifications.js';

const KIND: Record<ContactAlertDto['kind'], string> = { change: 'Изменены данные контакта', deleted: 'Контакт удалён в Битрикс24', missing: 'Контакт недоступен в Битрикс24' };
const STATUS: Record<ContactAlertDto['status'], string> = { new: 'Новый', viewed: 'В работе', resolved: 'Принято', ignored: 'Игнорируется' };

/**
 * Уведомление о контакте строкой общей ленты: что случилось, с кем, кто правил; только реально
 * изменённые поля — до 5, остальные под «Показать ещё». Значения скрыты, если контакт сотруднику не виден.
 */
export function ContactAlertRow({ a, timezone, busy, onStatus }: { a: ContactAlertDto; timezone: string; busy: boolean; onStatus: (s: ContactAlertDto['status']) => void }) {
  const [all, setAll] = useState(false);
  const sev = contactSeverity(a);
  const changes = realChanges(a.changes);
  const shown = all ? changes : changes.slice(0, CHANGES_SHOWN);
  const who = a.actor.attribution === 'last_editor' ? `${a.actor.accountType === 'system_user' ? 'системная учётная запись ' : ''}${a.actor.accountName ?? `#${a.actor.accountId}`}` : null;
  const open = a.status === 'new' || a.status === 'viewed';
  return (
    <li className={`nt-row sev-${sev}${open ? '' : ' done'}`}>
      <span className="nt-dot" title={SEVERITY_LABELS[sev]} aria-label={SEVERITY_LABELS[sev]} />
      <div className="nt-body">
        <div className="nt-line">
          <b className="nt-title">{KIND[a.kind]}</b>
          <button type="button" className="link nt-subject" onClick={() => openCrm('contact', a.contactId)} title="Открыть контакт">
            {a.contactName || `Контакт #${a.contactId}`}
          </button>
          <span className="nt-meta muted">
            {fmtDateTime(a.createdAt, timezone)}
            {who ? ` · ${who}` : ''}
          </span>
          <span className={`nt-status ${a.status}`}>{STATUS[a.status]}</span>
        </div>
        {a.restricted ? (
          <p className="nt-note muted">Значения скрыты правами CRM.</p>
        ) : (
          !!changes.length && (
            <ul className="nt-changes">
              {shown.map((c) => (
                <li key={c.field}>
                  <span className="nt-field">{c.label ?? c.field}</span>
                  <span className="nt-before">{fieldValue(c.before)}</span>
                  <span className="nt-arrow" aria-hidden="true">→</span>
                  <span className="nt-after">{fieldValue(c.after)}</span>
                </li>
              ))}
              {changes.length > CHANGES_SHOWN && (
                <li>
                  <button type="button" className="link nt-more" onClick={() => setAll(!all)}>
                    {all ? 'Свернуть' : `Показать ещё ${changes.length - CHANGES_SHOWN}`}
                  </button>
                </li>
              )}
            </ul>
          )
        )}
      </div>
      <div className="nt-actions">
        {open && (
          <button type="button" className="primary" disabled={busy} onClick={() => onStatus('resolved')}>
            Принять
          </button>
        )}
        {a.status === 'new' && (
          <button type="button" disabled={busy} onClick={() => onStatus('viewed')}>
            В работу
          </button>
        )}
        {open && (
          <button type="button" className="link" disabled={busy} onClick={() => onStatus('ignored')}>
            Игнорировать
          </button>
        )}
        {!open && (
          <button type="button" className="link" disabled={busy} onClick={() => onStatus('new')}>
            Вернуть
          </button>
        )}
      </div>
    </li>
  );
}
