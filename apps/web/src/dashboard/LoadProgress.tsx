import { useEffect, useRef, useState } from 'react';

/**
 * Примерный прогресс загрузки блока (решение владельца 2026-10-27): точного объёма ответа мы не знаем,
 * поэтому оцениваем по тому, сколько этот блок грузился в прошлые разы (среднее в localStorage
 * браузера сотрудника). Полоса растёт к ~95%, подпись — «≈N% · осталось ~X с».
 */
const KEY = 'btx24:load-ms';
const DEFAULT_MS = 4_000;

function expected(name: string): number {
  try {
    const v = (JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, number>)[name];
    return typeof v === 'number' && v > 200 && v < 120_000 ? v : DEFAULT_MS;
  } catch {
    return DEFAULT_MS;
  }
}

function remember(name: string, ms: number): void {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, number>;
    const prev = all[name];
    // Скользящее среднее: один медленный раз не портит оценку.
    all[name] = Math.round(typeof prev === 'number' ? prev * 0.6 + ms * 0.4 : ms);
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* без хранилища — оценка по умолчанию */
  }
}

/** Доля 0..0.95 за `elapsed` при ожидаемой длительности `total`: линейно до 80%, дальше — медленнее. */
export function progressOf(elapsed: number, total: number): number {
  const x = elapsed / Math.max(total, 1);
  return x <= 1 ? 0.8 * x : Math.min(0.95, 0.8 + 0.15 * (1 - Math.exp(-(x - 1))));
}

export function progressLabel(elapsed: number, total: number): string {
  const pct = Math.round(progressOf(elapsed, total) * 100);
  const left = Math.ceil((total - elapsed) / 1000);
  return left > 0 ? `≈${pct}% · осталось ~${left} с` : elapsed > total * 2 ? `≈${pct}% · дольше обычного, ждём Битрикс24…` : `≈${pct}% · почти готово…`;
}

/** Полоса и подпись прогресса; пока смонтирован — идёт загрузка, при размонтировании время запоминается. */
export function LoadProgress({ name, label }: { name: string; label?: string }) {
  const started = useRef(Date.now());
  const total = useRef(expected(name));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    const from = started.current;
    return () => {
      clearInterval(t);
      remember(name, Date.now() - from);
    };
  }, [name]);
  const elapsed = now - started.current;
  const p = progressOf(elapsed, total.current);
  return (
    <span className="load-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p * 100)} aria-label={label ?? 'Загрузка'}>
      <span className="load-progress-text">
        {label && <b>{label}</b>} {progressLabel(elapsed, total.current)}
      </span>
      <span className="load-progress-track" aria-hidden="true">
        <i style={{ width: `${p * 100}%` }} />
      </span>
    </span>
  );
}
