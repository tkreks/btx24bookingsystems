import { useEffect, useRef, useState } from 'react';
import { periodError, type PeriodPreset } from './period.js';

/** Варианты окна периода (решение владельца 2026-10-25): неделя — 7 дней, месяц — с 1-го числа. */
const OPTIONS: { key: PeriodPreset; label: string }[] = [
  { key: 'today', label: 'Сегодня' },
  { key: 'yesterday', label: 'Вчера' },
  { key: '7d', label: 'Неделя' },
  { key: 'month', label: 'Месяц' },
  { key: 'custom', label: 'Период' },
];

const short = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;

/** Подпись кнопки: название варианта или даты своего периода. */
export function periodLabel(preset: PeriodPreset, range: { from: string; to: string }): string {
  if (preset === 'custom') return range.from === range.to ? short(range.from) : `${short(range.from)} — ${short(range.to)}`;
  return OPTIONS.find((o) => o.key === preset)?.label ?? 'Сегодня';
}

/**
 * Период дашборда — текстом в шапке; по нажатию — небольшое окно: Сегодня, Вчера, Неделя, Месяц,
 * Период (начало и конец). Закрывается кликом мимо и Esc.
 */
export function PeriodPicker({ preset, range, onPreset, onRange }: { preset: PeriodPreset; range: { from: string; to: string }; onPreset: (p: Exclude<PeriodPreset, 'custom'>) => void; onRange: (r: { from: string; to: string }) => void }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(preset === 'custom');
  const [draft, setDraft] = useState(range);
  const ref = useRef<HTMLDivElement>(null);
  const error = periodError(draft.from, draft.to);

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

  return (
    <div className="period-picker" ref={ref}>
      <button
        type="button"
        className="period-picker-text"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Период дашборда"
        onClick={() => {
          setOpen(!open);
          setCustom(preset === 'custom');
          setDraft(range);
        }}
      >
        {periodLabel(preset, range)} <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="period-picker-pop" role="dialog" aria-label="Период дашборда">
          <div className="period-picker-options" role="radiogroup" aria-label="Период">
            {OPTIONS.map((o) => {
              const active = o.key === 'custom' ? custom : !custom && preset === o.key;
              return (
                <button
                  key={o.key}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={active ? 'active' : ''}
                  onClick={() => {
                    if (o.key === 'custom') return setCustom(true);
                    setCustom(false);
                    onPreset(o.key);
                    setOpen(false);
                  }}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
          {custom && (
            <form
              className="period-picker-custom"
              onSubmit={(e) => {
                e.preventDefault();
                if (error) return;
                onRange(draft);
                setOpen(false);
              }}
            >
              <label>
                Начало
                <input type="date" value={draft.from} required onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
              </label>
              <label>
                Конец
                <input type="date" value={draft.to} required onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
              </label>
              {error && <span className="muted">{error}</span>}
              <button type="submit" className="primary" disabled={!!error}>
                Показать
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
