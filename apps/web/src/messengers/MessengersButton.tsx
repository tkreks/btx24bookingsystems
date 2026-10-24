import { useEffect, useState } from 'react';
import type { MessengerDto } from '@btx24/shared';
import { apiGet } from '../api.js';
import { MessengerChatsDialog } from './MessengerChatsDialog.js';

/**
 * «Чаты» → 📱: номера групп сотрудника; для своей линии каждый диалог проверяет портал.
 */
export function MessengersButton({ timezone }: { timezone: string }) {
  const [items, setItems] = useState<MessengerDto[]>([]);
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<MessengerDto | null>(null);
  useEffect(() => void apiGet<MessengerDto[]>('/messengers').then((v) => setItems(v), () => undefined), []);
  if (!items.length) return null;
  return (
    <div className="cl-menu-wrap">
      <button
        className={`cl-btn${open ? ' active' : ''}`}
        aria-label="Мессенджеры"
        title="Мессенджеры групп"
        onClick={() => (items.length === 1 ? setCurrent(items[0]) : setOpen(!open))}
      >
        📱
      </button>
      {open && (
        <div className="cl-menu" role="menu">
          {items.map((m) => (
            <button key={m.id} role="menuitem" onClick={() => { setOpen(false); setCurrent(m); }}>
              {m.title ?? (m.kind === 'telegram' ? 'Telegram' : 'WhatsApp')} +{m.phone}
            </button>
          ))}
        </div>
      )}
      {current && <MessengerChatsDialog messenger={current} timezone={timezone} admin={false} onClose={() => setCurrent(null)} />}
    </div>
  );
}
