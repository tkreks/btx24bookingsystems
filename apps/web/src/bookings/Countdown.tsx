import { useEffect, useState } from 'react';

/** «1:23:45» / «12:05» — сколько осталось до срока. */
export function leftText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** Таймер до срока оплаты: тикает раз в секунду; меньше 10 минут — красный; вышел — «срок вышел». */
export function Countdown({ deadline, compact = false }: { deadline: string; compact?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Date.parse(deadline) - now;
  if (left <= 0) return <span className="countdown over">{compact ? 'срок вышел' : 'срок вышел — бронь снимается'}</span>;
  return (
    <span className={`countdown${left < 10 * 60_000 ? ' soon' : ''}`} title={`Оплатить до ${new Date(deadline).toLocaleString('ru-RU')}`}>
      ⏱ {compact ? '' : 'осталось '}
      {leftText(left)}
    </span>
  );
}
