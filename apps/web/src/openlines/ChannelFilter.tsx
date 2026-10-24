import { useEffect, useRef, useState } from 'react';
import type { MessengerDto } from '@btx24/shared';
import { apiGet } from '../api.js';
import { Channel } from './Channel.js';
import { connectorLabel } from './format.js';

/** +7 499 346-72-72; не российский — как есть, с «+». */
export function fmtLinePhone(digits: string): string {
  const m = /^7(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(digits);
  return m ? `+7 ${m[1]} ${m[2]}-${m[3]}-${m[4]}` : `+${digits}`;
}

/**
 * Фильтр списка чатов по каналу сообщений: значок канала, название и — для номеров, подключённых в
 * приложении (WhatsApp, Telegram), — их телефоны мелким шрифтом. Каналы чужих коннекторов — без номера.
 */
export function ChannelFilter({ channels, value, onChange }: { channels: string[]; value: string; onChange: (code: string) => void }) {
  const [open, setOpen] = useState(false);
  const [numbers, setNumbers] = useState<MessengerDto[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => void apiGet<MessengerDto[]>('/messengers').then(setNumbers, () => undefined), []);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  const phones = (code: string) =>
    numbers
      .filter((m) => m.kind === code)
      .map((m) => fmtLinePhone(m.phone))
      .join(' · ');
  const pick = (code: string) => {
    setOpen(false);
    onChange(code);
  };
  const row = (code: string) => (
    <>
      {code ? <Channel connector={code} /> : <span className="cf-all">Все каналы</span>}
      {code && phones(code) && <span className="cf-phone">{phones(code)}</span>}
    </>
  );
  return (
    <div className="cf" ref={ref}>
      <button type="button" className="cf-current" aria-haspopup="listbox" aria-expanded={open} aria-label={`Канал сообщений: ${value ? connectorLabel(value) : 'все'}`} onClick={() => setOpen(!open)}>
        <span className="cf-caption">Канал</span>
        <span className="cf-value">{row(value)}</span>
        <span className="cf-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <ul className="cf-menu" role="listbox" aria-label="Канал сообщений">
          {['', ...channels].map((code) => (
            <li key={code || 'all'}>
              <button type="button" role="option" aria-selected={code === value} className={code === value ? 'selected' : ''} onClick={() => pick(code)}>
                {row(code)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
