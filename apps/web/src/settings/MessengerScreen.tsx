import { useEffect, useRef, useState } from 'react';
import type { MessengerScreenFilesDto, MessengerVncTicketDto } from '@btx24/shared';
import { apiBlob, apiDelete, apiGet, apiPost, apiUpload } from '../api.js';

/**
 * Экран браузера мессенджера (ADR 0014): по VNC — живой, с мышью и клавиатурой (вход по QR, проверка
 * WhatsApp Web); не открылся — снимок экрана раз в 3 секунды. `base` — `/admin/messengers` (⚙) или
 * `/messengers` (блок дашборда: право писать с номера); `files` — панель файлов для отправки с экрана.
 */
export function MessengerScreen({ id, onClose, base = '/admin/messengers', files = false, title = 'Экран мессенджера' }: { id: string; onClose: () => void; base?: string; files?: boolean; title?: string }) {
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
        const [{ default: RFB }, ticket] = await Promise.all([import('@novnc/novnc'), apiPost<MessengerVncTicketDto>(`${base}/${id}/vnc-ticket`)]);
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
  }, [id, mode, base]);

  useEffect(() => {
    if (mode !== 'shot') return;
    let active = true;
    let url: string | null = null;
    const load = () =>
      apiBlob(`${base}/${id}/screenshot`).then(
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
  }, [id, mode, base]);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet messenger-screen" role="dialog" aria-modal="true" aria-label="Экран мессенджера" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{title}</h2>
          <button type="button" onClick={() => setMode(mode === 'vnc' ? 'shot' : 'vnc')}>
            {mode === 'vnc' ? 'Снимок экрана' : 'Живой экран (VNC)'}
          </button>
          <button type="button" aria-label="Закрыть экран" onClick={onClose}>
            ×
          </button>
        </header>
        {status && <p className="muted" role="status">{status}</p>}
        {mode === 'vnc' ? <div ref={box} className="messenger-vnc" /> : shot && <img className="messenger-shot" src={shot} alt="Снимок экрана браузера" />}
        {files && <ScreenFiles id={id} />}
      </div>
    </div>
  );
}

const fmtSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`);
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

/**
 * Файлы для отправки с экрана: загрузить (хранятся час), «Прикрепить» — следующее окно выбора файла
 * в мессенджере получит этот файл (нажмите 📎 на экране), дальше — отправить как обычно.
 */
function ScreenFiles({ id }: { id: string }) {
  const [state, setState] = useState<MessengerScreenFilesDto | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const path = `/messengers/${id}/screen-files`;
  const run = (p: Promise<MessengerScreenFilesDto>) => {
    setBusy(true);
    setError('');
    return p.then(setState, (e) => setError(e instanceof Error ? e.message : 'Не получилось')).finally(() => setBusy(false));
  };
  const offer = state?.offer ?? null;

  useEffect(() => {
    void apiGet<MessengerScreenFilesDto>(path).then(setState, (e) => setError(e instanceof Error ? e.message : 'Файлы недоступны'));
  }, [path]);
  // Ждём нажатия 📎 на экране — обновляем, чтобы увидеть «прикреплён»; иначе раз в минуту (файлы уходят через час).
  useEffect(() => {
    const t = setInterval(() => void apiGet<MessengerScreenFilesDto>(path).then(setState, () => undefined), offer ? 2000 : 60_000);
    return () => clearInterval(t);
  }, [path, offer]);

  const upload = async (list: FileList | null) => {
    for (const f of Array.from(list ?? [])) await run(apiUpload<MessengerScreenFilesDto>(path, f));
    if (input.current) input.current.value = '';
  };

  return (
    <section className="screen-files" aria-label="Файлы для отправки">
      <div className="screen-files-head">
        <b>Файлы для отправки</b>
        <span className="muted">хранятся час, потом удаляются</span>
        <button type="button" className="primary" disabled={busy} onClick={() => input.current?.click()}>
          Загрузить файл
        </button>
        <input ref={input} type="file" multiple hidden onChange={(e) => void upload(e.target.files)} />
      </div>
      {error && <p className="notice error" role="alert">{error}</p>}
      {offer && (
        <p className="notice screen-files-offer" role="status">
          Нажмите 📎 в окне мессенджера и выберите «Документ» или «Фото и видео» — файл
          «{state?.files.find((f) => f.id === offer.fileId)?.name ?? 'файл'}» подставится сам (до {hhmm(offer.until)}). Затем отправьте сообщение.{' '}
          <button type="button" className="link" onClick={() => void run(apiDelete(path))}>
            Отменить
          </button>
        </p>
      )}
      {state && !state.files.length && <p className="muted">Файлов нет. Загрузите файл — его можно будет прикрепить в окне мессенджера.</p>}
      <ul className="screen-files-list">
        {state?.files.map((f) => (
          <li key={f.id}>
            <span className="screen-file-name" title={f.name}>{f.name}</span>
            <span className="muted">{fmtSize(f.size)} · удалится в {hhmm(f.expiresAt)}{f.attachedAt ? ` · прикреплён в ${hhmm(f.attachedAt)}` : ''}</span>
            <button type="button" disabled={busy} className={offer?.fileId === f.id ? 'active' : ''} onClick={() => void run(apiPost(`${path}/${f.id}/attach`))}>
              {offer?.fileId === f.id ? 'Ждём 📎…' : 'Прикрепить'}
            </button>
            <button type="button" aria-label={`Удалить ${f.name}`} disabled={busy} onClick={() => void run(apiDelete(`${path}/${f.id}`))}>
              ×
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
