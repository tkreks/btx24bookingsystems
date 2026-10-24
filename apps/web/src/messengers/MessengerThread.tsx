import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { MESSENGER_MAX_FILE_BYTES, type MessengerMessageDto } from '@btx24/shared';
import { fmtDateTime } from '../format.js';

/** Что умеет переписка: загрузить (страницу раньше `before`), отправить, изменить, удалить у всех. */
export interface ThreadApi {
  load: (before?: string) => Promise<MessengerMessageDto[]>;
  /** null — передано в открытую линию: появится в переписке, когда линия доставит. */
  send: (text: string) => Promise<MessengerMessageDto | null>;
  media: (id: string) => Promise<Blob>;
  sendFile: (file: File, text: string) => Promise<MessengerMessageDto | null>;
  edit: (id: string, text: string) => Promise<MessengerMessageDto>;
  remove: (id: string) => Promise<MessengerMessageDto>;
}

const ACK = ['🕓', '✓', '✓✓', '✓✓'] as const;
const SOURCE: Record<MessengerMessageDto['source'], string> = { messenger: '', app: 'из приложения', bitrix: 'из открытой линии' };
/** WhatsApp разрешает менять своё сообщение в течение 15 минут. */
const EDIT_MS = 15 * 60_000;
const POLL_MS = 4000;

/**
 * Переписка мессенджера (ADR 0014): сообщения из базы приложения, новые подтягиваются каждые 4 с.
 * Изменённое — с пометкой и прежним текстом во всплывающей подсказке; удалённое — зачёркнуто, с
 * пометкой «удалено» (текст сохраняется). Своё можно изменить (15 минут) и удалить у всех.
 */
export function MessengerThread({ api, timezone, canSend = true, label }: { api: ThreadApi; timezone: string; canSend?: boolean; label: string }) {
  const [items, setItems] = useState<MessengerMessageDto[] | null>(null);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const [sending, setSending] = useState(false);
  const [editing, setEditing] = useState<MessengerMessageDto | null>(null);
  const [notice, setNotice] = useState('');
  // «Можно изменить» зависит от времени — часы обновляются вместе с опросом.
  const [now, setNow] = useState(() => Date.now());
  const list = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  const merge = useCallback((fresh: MessengerMessageDto[]) => {
    setItems((prev) => {
      const map = new Map((prev ?? []).map((m) => [m.id, m]));
      for (const m of fresh) map.set(m.id, m);
      return [...map.values()].sort((a, b) => a.sentAt.localeCompare(b.sentAt));
    });
  }, []);

  useEffect(() => {
    let active = true;
    const tick = () =>
      api.load().then(
        (v) => {
          if (!active) return;
          merge(v);
          setNow(Date.now());
          setError('');
        },
        (e) => active && setError(e instanceof Error ? e.message : 'Не удалось загрузить переписку'),
      );
    void tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api, merge]);

  useEffect(() => {
    if (atBottom.current && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [items]);

  const older = async () => {
    if (!items?.length) return;
    merge(await api.load(items[0].sentAt));
  };

  const submit = async () => {
    const body = text.trim();
    if (submitting.current || (!body && !file) || (editing && !body)) return;
    submitting.current = true;
    setSending(true);
    setError('');
    try {
      const done = editing ? await api.edit(editing.id, body) : file ? await api.sendFile(file, body) : await api.send(body);
      if (done) merge([done]);
      setNotice(done ? '' : 'Передано в открытую линию Битрикс24 — сообщение появится здесь, когда линия доставит его клиенту.');
      setText('');
      setFile(null);
      setEditing(null);
      atBottom.current = true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось отправить');
    } finally {
      submitting.current = false;
      setSending(false);
    }
  };

  const remove = async (m: MessengerMessageDto) => {
    if (!confirm('Удалить сообщение у всех? У клиента оно тоже исчезнет.')) return;
    try {
      merge([await api.remove(m.id)]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось удалить');
    }
  };

  return (
    <div className="mt">
      <div
        className="mt-list"
        ref={list}
        aria-live="polite"
        aria-label={`Переписка ${label}`}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {items === null && !error && <p className="muted pad">Загрузка переписки…</p>}
        {items?.length === 0 && <p className="muted pad">Сообщений пока нет.</p>}
        {!!items?.length && (
          <button type="button" className="link older" onClick={() => void older()}>
            Показать более ранние
          </button>
        )}
        {items?.map((m) => {
          const own = m.fromMe;
          const canEdit = own && !m.deletedAt && now - Date.parse(m.sentAt) < EDIT_MS && m.type === 'chat';
          return (
            <Fragment key={m.id}>
              <div className={`mt-msg${own ? ' own' : ''}${m.deletedAt ? ' deleted' : ''}`}>
                {m.hasMedia && !m.deletedAt && <MessengerMedia message={m} api={api} onReady={() => { if (atBottom.current && list.current) list.current.scrollTop = list.current.scrollHeight; }} />}
                <div className="mt-body">{m.body}</div>
                <div className="mt-meta">
                  <span>{fmtDateTime(m.sentAt, timezone)}</span>
                  {m.editedAt && (
                    <span className="mt-edited" title={m.edits.map((e) => `${fmtDateTime(e.at, timezone)}: ${e.body}`).join('\n') || undefined}>
                      изменено
                    </span>
                  )}
                  {m.deletedAt && <span className="mt-deleted">удалено {fmtDateTime(m.deletedAt, timezone)}</span>}
                  {own && SOURCE[m.source] && <span>{SOURCE[m.source]}</span>}
                  {own && m.ack !== null && !m.deletedAt && <span className={m.ack >= 3 ? 'mt-read' : ''}>{ACK[Math.min(3, Math.max(0, m.ack))]}</span>}
                  {m.relayError && <span className="mt-error" title={m.relayError}>не передано в открытую линию</span>}
                  {canSend && canEdit && (
                    <button type="button" className="link" onClick={() => { setEditing(m); setText(m.body); setFile(null); }}>
                      изменить
                    </button>
                  )}
                  {canSend && own && !m.deletedAt && (
                    <button type="button" className="link" onClick={() => void remove(m)}>
                      удалить
                    </button>
                  )}
                </div>
              </div>
            </Fragment>
          );
        })}
      </div>
      {error && <div className="notice error" role="alert">{error}</div>}
      {notice && <div className="notice" role="status">{notice}</div>}
      {canSend && (
        <form
          className="mt-composer"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {editing && (
            <div className="mt-editing">
              Изменение сообщения ·{' '}
              <button type="button" className="link" onClick={() => { setEditing(null); setText(''); }}>
                отмена
              </button>
            </div>
          )}
          {file && <div className="mt-file-selection"><span>📎 {file.name} · {fileSize(file.size)}</span><button type="button" className="link" disabled={sending} onClick={() => setFile(null)}>Убрать файл</button></div>}
          <input type="file" ref={fileInput} hidden onChange={e => {
            const selected = e.currentTarget.files?.[0]; e.currentTarget.value = '';
            if (!selected) return;
            if (selected.size > MESSENGER_MAX_FILE_BYTES) { setError('Файл больше 64 МБ'); return; }
            if (!selected.size) { setError('Пустой файл нельзя отправить'); return; }
            setError(''); setFile(selected);
          }} />
          {!editing && <button type="button" className="mt-attach" aria-label="Прикрепить файл" title="Прикрепить файл до 64 МБ" disabled={sending} onClick={() => fileInput.current?.click()}>📎</button>}
          <textarea
            value={text}
            disabled={sending}
            rows={2}
            placeholder={`Сообщение через ${label}`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <button className="primary" disabled={sending || (!text.trim() && !file)}>
            {sending ? 'Отправляем…' : editing ? 'Сохранить' : 'Отправить'}
          </button>
        </form>
      )}
    </div>
  );
}


function fileSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

/** Blob URL получается только после аутентифицированного запроса, при смене чата освобождается. */
function MessengerMedia({ message: m, api, onReady }: { message: MessengerMessageDto; api: ThreadApi; onReady: () => void }) {
  const [file, setFile] = useState<{ url: string; mime: string } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [requested, setRequested] = useState(false);
  const inline = /^(image\/(jpeg|png|gif|webp|avif)|video\/(mp4|webm|ogg)|audio\/)/i.test(m.media?.mime ?? '');
  useEffect(() => {
    if (!inline && !requested) return;
    let active = true; let url: string | null = null;
    api.media(m.id).then(blob => {
      if (!active) return;
      url = URL.createObjectURL(blob); setFile({ url, mime: blob.type }); setError('');
    }, e => active && setError(e instanceof Error ? e.message : 'Не удалось загрузить вложение'));
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [api, m.id, inline, requested, revision]);
  const download = async () => {
    if (loading) return; setLoading(true);
    try {
      const blob = await api.media(m.id); const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = m.media?.name || `file-${m.id}`; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось скачать файл'); }
    finally { setLoading(false); }
  };
  const mime = file?.mime || m.media?.mime || '';
  return <div className="mt-media">
    {file && /^image\/(jpeg|png|gif|webp|avif)/i.test(mime) && <a href={file.url} target="_blank" rel="noreferrer"><img src={file.url} alt={m.media?.name || 'Фото'} onLoad={onReady} /></a>}
    {file && /^video\/(mp4|webm|ogg)/i.test(mime) && <video controls preload="metadata" src={file.url} onLoadedMetadata={onReady} />}
    {file && /^audio\//i.test(mime) && <audio controls preload="metadata" src={file.url} />}
    {inline && !file && !error && <span className="muted">Загрузка вложения…</span>}
    {!inline && !file && <button type="button" className="link" onClick={() => setRequested(true)}>Открыть вложение</button>}
    <button type="button" className="link mt-download" disabled={loading} onClick={() => void download()}>📎 {loading ? 'Скачиваем…' : m.media?.name || 'Скачать вложение'}{m.media?.size ? ` · ${fileSize(m.media.size)}` : ''}</button>
    {error && <span className="mt-media-error" role="alert">{error} <button type="button" className="link" onClick={() => setRevision(n => n + 1)}>Повторить</button></span>}
  </div>;
}
