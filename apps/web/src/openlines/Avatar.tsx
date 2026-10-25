import { useState } from 'react';
import { avatarTone, initials } from './chat-list.js';

/**
 * Аватарка из Битрикс24; нет картинки или не загрузилась — инициалы на цветном круге. `size: null` —
 * размер задаёт CSS (`className`, например `large`).
 */
export function Avatar({ src, name, size = 28, tone, className = '' }: { src?: string | null; name: string; size?: number | null; tone?: number; className?: string }) {
  const [broken, setBroken] = useState<string | null>(null);
  const style = size ? { width: size, height: size, fontSize: Math.round(size * 0.4) } : undefined;
  const extra = className ? ` ${className}` : '';
  if (src && broken !== src)
    return <img className={`avatar avatar-img${extra}`} src={src} alt="" style={style} loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(src)} />;
  const t = tone ?? avatarTone([...name].reduce((n, ch) => n + ch.charCodeAt(0), 0));
  return (
    <span className={`avatar a${t}${extra}`} style={style} aria-hidden="true">
      {initials(name)}
    </span>
  );
}
