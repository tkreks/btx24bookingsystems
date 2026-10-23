import { useEffect, useState } from 'react';
import type { ActiveCallDto, CallCardDto } from '@btx24/shared';
import { apiGet } from '../api.js';
import { MinimizeButton } from '../Minimize.js';
import { CallCard } from './CallCard.js';

const POLL_MS = 6000;

/**
 * Звонок в открытом приложении (решение владельца 2026-10-23): сотрудник ответил на звонок в Битрикс24
 * (событие телефонии) — внизу экрана «📞 Звонок …», по нажатию — карточка клиента. Опрос — раз в 6 с,
 * пока вкладка видна; ответ берётся из базы приложения (без запросов к порталу).
 */
export function CallWatcher({ timezone, canCreate, onCreate }: { timezone: string; canCreate: boolean; onCreate: (card: CallCardDto) => void }) {
  const [calls, setCalls] = useState<ActiveCallDto[]>([]);
  const [open, setOpen] = useState<ActiveCallDto | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let active = true;
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      apiGet<ActiveCallDto[]>('/calls/active').then(
        (r) => active && setCalls(r),
        () => undefined,
      );
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, []);

  const current = calls.find((c) => !dismissed.has(c.callId)) ?? null;
  return (
    <>
      {current && !open && (
        <button className="call-chip" onClick={() => setOpen(current)} title="Карточка клиента по звонку">
          <span aria-hidden="true">📞</span> {current.callType === 1 ? 'Исходящий' : 'Звонок'} {current.phone ?? ''} — клиент
        </button>
      )}
      {open && (
        <div className="sheet-backdrop" onClick={() => setOpen(null)}>
          <div className="sheet call-sheet" role="dialog" aria-modal="true" aria-label="Звонок клиента" onClick={(e) => e.stopPropagation()}>
            <header>
              <h2>📞 Звонок {open.phone ?? ''}</h2>
              <MinimizeButton label="Звонок" />
              <button
                aria-label="Закрыть"
                onClick={() => {
                  setDismissed((d) => new Set(d).add(open.callId));
                  setOpen(null);
                }}
              >
                ×
              </button>
            </header>
            <CallCard
              call={{ callId: open.callId, phone: open.phone }}
              timezone={timezone}
              canCreate={canCreate}
              onCreate={(card) => {
                setDismissed((d) => new Set(d).add(open.callId));
                setOpen(null);
                onCreate(card);
              }}
            />
          </div>
        </div>
      )}
    </>
  );
}
