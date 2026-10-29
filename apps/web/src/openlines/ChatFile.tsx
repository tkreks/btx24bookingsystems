import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatFileDto } from '@btx24/shared';
import { apiBlob } from '../api.js';
import { fileSize } from './format.js';
import { Icon } from './icons.js';

const IMAGE = /\.(jpe?g|png|gif|webp|bmp|heic)$/i;
const VIDEO = /\.(mp4|mov|webm|m4v|3gp|avi)$/i;
const AUDIO = /\.(mp3|ogg|oga|opus|m4a|wav|aac)$/i;
const MIME: [RegExp, string][] = [
  [/\.jpe?g$/i, 'image/jpeg'],
  [/\.png$/i, 'image/png'],
  [/\.gif$/i, 'image/gif'],
  [/\.webp$/i, 'image/webp'],
  [/\.(mp4|m4v)$/i, 'video/mp4'],
  [/\.mov$/i, 'video/quicktime'],
  [/\.webm$/i, 'video/webm'],
  [/\.(ogg|oga|opus)$/i, 'audio/ogg'],
  [/\.mp3$/i, 'audio/mpeg'],
  [/\.m4a$/i, 'audio/mp4'],
];
const kindOf = (f: ChatFileDto) =>
  f.type === 'image' || IMAGE.test(f.name) ? 'image' : f.type === 'video' || VIDEO.test(f.name) ? 'video' : f.type === 'audio' || AUDIO.test(f.name) ? 'audio' : 'file';

/**
 * Файл сообщения через сервер приложения (`/openlines/chats/:id/files/:fileId`): ссылки портала
 * во фрейме не открываются. Картинки грузятся, когда видны; видео и аудио — по нажатию.
 */
export function ChatFile({ chatId, f }: { chatId: number; f: ChatFileDto }) {
  // Описание файла портал не отдал (сотрудник не в диалоге) — вид узнаём по скачанному файлу.
  const unknown = f.type === 'unknown';
  const [detected, setDetected] = useState<ReturnType<typeof kindOf> | null>(null);
  const kind = unknown ? (detected ?? 'file') : kindOf(f);
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const box = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async (): Promise<string | null> => {
    if (url) return url;
    setState('loading');
    try {
      const blob = await apiBlob(`/openlines/chats/${chatId}/files/${f.id}`);
      const type = MIME.find(([re]) => re.test(f.name))?.[1];
      const u = URL.createObjectURL(type && blob.type !== type ? new Blob([blob], { type }) : blob);
      if (unknown) setDetected(/^image\//.test(blob.type) ? 'image' : /^video\//.test(blob.type) ? 'video' : /^audio\//.test(blob.type) ? 'audio' : 'file');
      setUrl(u);
      setState('idle');
      return u;
    } catch {
      setState('error');
      return null;
    }
  }, [chatId, f.id, f.name, url, unknown]);

  // Картинка — когда попала в область видимости.
  useEffect(() => {
    if (kind !== 'image' || url || !box.current) return;
    const io = new IntersectionObserver((e) => {
      if (e.some((x) => x.isIntersecting)) {
        io.disconnect();
        void load();
      }
    });
    io.observe(box.current);
    return () => io.disconnect();
  }, [kind, url, load]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);

  const save = async () => {
    // Неизвестное вложение: первое нажатие — показать (картинка/видео/аудио), не скачивать.
    if (unknown && !url) {
      await load();
      return;
    }
    const u = await load();
    if (!u) return;
    const a = document.createElement('a');
    a.href = u;
    a.download = f.name;
    a.click();
  };

  return (
    <div className={`msg-file ${kind}`} ref={box}>
      {kind === 'image' && url && (
        <a href={url} target="_blank" rel="noreferrer">
          <img src={url} alt={f.name} />
        </a>
      )}
      {kind === 'image' && !url && <span className="msg-media-ph">{state === 'error' ? 'Не удалось загрузить картинку' : 'Загрузка…'}</span>}
      {kind === 'video' && url && <video src={url} controls preload="metadata" />}
      {kind === 'audio' && url && <audio src={url} controls />}
      {(kind === 'video' || kind === 'audio') && !url && (
        <button type="button" className="msg-media-ph" onClick={() => void load()} disabled={state === 'loading'}>
          {state === 'loading' ? 'Загрузка…' : state === 'error' ? 'Не удалось загрузить — ещё раз' : `▶ ${kind === 'video' ? 'Видео' : 'Аудио'}`}
        </button>
      )}
      <button type="button" className="link msg-file-name" onClick={() => void save()}>
        {kind === 'file' && <Icon name="clip" size={14} />} {unknown && !url ? (state === 'loading' ? 'Загрузка вложения…' : state === 'error' ? 'Не удалось загрузить вложение — ещё раз' : 'Вложение — показать') : f.name}{' '}
        {f.size > 0 && <span className="muted">{fileSize(f.size)}</span>}
      </button>
    </div>
  );
}
