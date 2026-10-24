import { useEffect, useRef, useState } from 'react';
import type { MessengerVncTicketDto } from '@btx24/shared';
import { apiBlob, apiPost } from '../api.js';

/**
 * Экран браузера мессенджера (ADR 0014): по VNC — живой, с мышью и клавиатурой (вход по QR, проверка
 * WhatsApp Web); не открылся — снимок экрана раз в 3 секунды.
 */
export function MessengerScreen({ id, onClose }: { id: string; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<'vnc' | 'shot'>('vnc');
  const [status, setStatus] = useState('Подключаемся к экрану…');
  const [shot, setShot] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== 'vnc' || !box.current) return;
    let rfb: { disconnect(): void } | null = null;
    let active = true;
    void (async () => {
      try {
        const [{ default: RFB }, ticket] = await Promise.all([import('@novnc/novnc'), apiPost<MessengerVncTicketDto>(`/admin/messengers/${id}/vnc-ticket`)]);
        if (!active || !box.current) return;
        const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${ticket.url}`;
        const r = new RFB(box.current, url, { shared: true });
        r.scaleViewport = true;
        r.addEventListener('connect', () => setStatus(''));
        r.addEventListener('disconnect', () => active && setStatus('Экран отключился. Можно открыть снимок экрана.'));
        rfb = r;
      } catch (e) {
        if (active) setStatus(e instanceof Error ? e.message : 'Экран недоступен');
      }
    })();
    return () => {
      active = false;
      rfb?.disconnect();
    };
  }, [id, mode]);

  useEffect(() => {
    if (mode !== 'shot') return;
    let active = true;
    let url: string | null = null;
    const load = () =>
      apiBlob(`/admin/messengers/${id}/screenshot`).then(
        (b) => {
          if (!active) return;
          if (url) URL.revokeObjectURL(url);
          url = URL.createObjectURL(b);
          setShot(url);
          setStatus('');
        },
        (e) => active && setStatus(e instanceof Error ? e.message : 'Снимок недоступен'),
      );
    void load();
    const timer = setInterval(load, 3000);
    return () => {
      active = false;
      clearInterval(timer);
      if (url) URL.revokeObjectURL(url);
    };
  }, [id, mode]);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet messenger-screen" role="dialog" aria-modal="true" aria-label="Экран мессенджера" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Экран мессенджера</h2>
          <button type="button" onClick={() => setMode(mode === 'vnc' ? 'shot' : 'vnc')}>
            {mode === 'vnc' ? 'Снимок экрана' : 'Живой экран (VNC)'}
          </button>
          <button type="button" aria-label="Закрыть экран" onClick={onClose}>
            ×
          </button>
        </header>
        {status && <p className="muted" role="status">{status}</p>}
        {mode === 'vnc' ? <div ref={box} className="messenger-vnc" /> : shot && <img className="messenger-shot" src={shot} alt="Снимок экрана браузера" />}
      </div>
    </div>
  );
}
