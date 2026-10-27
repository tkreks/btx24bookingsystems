import { useEffect, useRef, useState } from 'react';
import type { MessengerScreenFileDto, MessengerScreenFilesDto, MessengerVncTicketDto } from '@btx24/shared';
import { Icon } from '../openlines/icons.js';
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
  const [pasteNote, setPasteNote] = useState('');

  // Ctrl+V и перетаскивание с компьютера на живой экран (решение владельца 2026-10-27): буфер VNC
  // кириллицу не передаёт, поэтому текст и файлы вставляет сервис мессенджеров в браузер номера.
  useEffect(() => {
    const el = box.current;
    if (mode !== 'vnc' || !el) return;
    const paste = async (what: { text: string } | { file: File }) => {
      setPasteNote('text' in what ? 'Вставляем текст…' : `Вставляем файл «${what.file.name}»…`);
      try {
        if ('text' in what) await apiPost(`/messengers/${id}/screen-paste`, { text: what.text });
        else await apiUpload(`/messengers/${id}/screen-paste-file`, what.file);
        setPasteNote('');
      } catch (e) {
        setPasteNote(e instanceof Error ? `Не вставилось: ${e.message}` : 'Не вставилось');
      }
    };
    const pasteAll = (files: File[], text: string) => {
      if (files.length) files.reduce((p, file) => p.then(() => paste({ file })), Promise.resolve());
      else if (text) void paste({ text });
    };
    // Ctrl+V не отдаём noVNC (он нажал бы его на экране с пустым буфером) — браузер пришлёт событие «вставить».
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.code === 'KeyV') e.stopPropagation();
    };
    const onPaste = (e: ClipboardEvent) => {
      if (!el.contains(document.activeElement)) return;
      e.preventDefault();
      pasteAll([...(e.clipboardData?.files ?? [])], e.clipboardData?.getData('text/plain') ?? '');
    };
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      pasteAll([...(e.dataTransfer?.files ?? [])], e.dataTransfer?.getData('text/plain') ?? '');
    };
    el.addEventListener('keydown', onKey, true);
    document.addEventListener('paste', onPaste);
    el.addEventListener('dragover', onDragOver);
    el.addEventListener('drop', onDrop);
    return () => {
      el.removeEventListener('keydown', onKey, true);
      document.removeEventListener('paste', onPaste);
      el.removeEventListener('dragover', onDragOver);
      el.removeEventListener('drop', onDrop);
    };
  }, [id, mode]);

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
        <header className="ms-head">
          <h2>{title}</h2>
          <span className="muted ms-note" role="status" title={status || pasteNote || PASTE_HINT}>
            {status || pasteNote || (mode === 'vnc' ? PASTE_HINT : 'Снимок экрана, обновляется раз в 3 секунды')}
          </span>
          {files && <ScreenFilesButton id={id} />}
          <button
            type="button"
            className={`ms-icon${mode === 'shot' ? ' active' : ''}`}
            aria-pressed={mode === 'shot'}
            title={mode === 'vnc' ? 'Снимок экрана (если живой экран не открывается)' : 'Вернуться к живому экрану'}
            aria-label={mode === 'vnc' ? 'Снимок экрана' : 'Живой экран'}
            onClick={() => setMode(mode === 'vnc' ? 'shot' : 'vnc')}
          >
            <Icon name="camera" size={18} />
          </button>
          <button type="button" className="ms-icon" aria-label="Закрыть экран" title="Закрыть" onClick={onClose}>
            ×
          </button>
        </header>
        {mode === 'vnc' ? <div ref={box} className="messenger-vnc" /> : shot && <img className="messenger-shot" src={shot} alt="Снимок экрана браузера" />}
      </div>
    </div>
  );
}

const PASTE_HINT = 'Ctrl+V — вставить текст или файл в поле под курсором; файлы можно перетащить на экран';
const fmtSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`);
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

/** Тип файла для значка «папки»: подпись и цвет как у программы, которая его откроет. */
export function fileKind(name: string, mime: string): { label: string; tone: string; app: string } {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  if (mime === 'application/pdf' || ext === 'pdf') return { label: 'PDF', tone: 'pdf', app: 'PDF-просмотрщик' };
  if (['doc', 'docx', 'rtf', 'odt'].includes(ext)) return { label: 'W', tone: 'word', app: 'Word' };
  if (['xls', 'xlsx', 'csv', 'ods'].includes(ext)) return { label: 'X', tone: 'excel', app: 'Excel' };
  if (['ppt', 'pptx', 'odp'].includes(ext)) return { label: 'P', tone: 'ppt', app: 'PowerPoint' };
  if (['zip', 'rar', '7z', 'gz', 'tar'].includes(ext)) return { label: 'ZIP', tone: 'zip', app: 'Архиватор' };
  if (mime.startsWith('video/')) return { label: '▶', tone: 'video', app: 'Видеоплеер' };
  if (mime.startsWith('audio/')) return { label: '♪', tone: 'audio', app: 'Аудиоплеер' };
  if (mime.startsWith('image/')) return { label: 'IMG', tone: 'image', app: 'Просмотр фото' };
  if (mime.startsWith('text/') || ['txt', 'md', 'log'].includes(ext)) return { label: 'TXT', tone: 'text', app: 'Блокнот' };
  return { label: ext.slice(0, 4).toUpperCase() || 'FILE', tone: 'other', app: 'Файл' };
}

/**
 * Скрепка в шапке экрана: загрузить файл; есть загруженные — кружок с числом, по нажатию — окно
 * файлов в виде папки (миниатюры картинок, значки документов). Ожидание 📎 — строкой под шапкой.
 */
function ScreenFilesButton({ id }: { id: string }) {
  const [state, setState] = useState<MessengerScreenFilesDto | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
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
  const count = state?.files.length ?? 0;

  return (
    <>
      <span className="ms-files">
        <button type="button" className="ms-icon" disabled={busy} title="Загрузить файл для отправки с экрана (хранится час)" aria-label="Загрузить файл" onClick={() => input.current?.click()}>
          <Icon name="clip" size={18} />
        </button>
        {count > 0 && (
          <button type="button" className="ms-files-count" title={`Загруженные файлы: ${count}`} aria-label={`Открыть загруженные файлы: ${count}`} onClick={() => setOpen(true)}>
            {count}
          </button>
        )}
        <input ref={input} type="file" multiple hidden onChange={(e) => void upload(e.target.files)} />
      </span>
      {(error || offer) && (
        <p className={`notice ms-files-line${error ? ' error' : ''}`} role={error ? 'alert' : 'status'}>
          {error ||
            `Нажмите 📎 в окне мессенджера — файл «${state?.files.find((f) => f.id === offer!.fileId)?.name ?? 'файл'}» подставится сам (до ${hhmm(offer!.until)}).`}{' '}
          {offer && !error && (
            <button type="button" className="link" onClick={() => void run(apiDelete(path))}>
              Отменить
            </button>
          )}
        </p>
      )}
      {open && state && (
        <FilesFolder
          id={id}
          state={state}
          busy={busy}
          onUpload={() => input.current?.click()}
          onAttach={(fileId) => void run(apiPost(`${path}/${fileId}/attach`)).then(() => setOpen(false))}
          onPaste={(fileId) => {
            setOpen(false);
            void apiPost(`/messengers/${id}/screen-paste`, { fileId }).catch((e) => setError(e instanceof Error ? e.message : 'Не вставилось'));
          }}
          onRemove={(fileId) => void run(apiDelete(`${path}/${fileId}`))}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** Окно файлов экрана в виде папки Проводника: плитки, двойной клик — вставить в открытый чат. */
function FilesFolder({ id, state, busy, onUpload, onAttach, onPaste, onRemove, onClose }: {
  id: string;
  state: MessengerScreenFilesDto;
  busy: boolean;
  onUpload: () => void;
  onAttach: (fileId: string) => void;
  onPaste: (fileId: string) => void;
  onRemove: (fileId: string) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const sel = state.files.find((f) => f.id === selected) ?? null;
  return (
    <div className="sheet-backdrop folder-backdrop" onClick={onClose}>
      <div className="folder" role="dialog" aria-modal="true" aria-label="Файлы для отправки" onClick={(e) => e.stopPropagation()}>
        <header className="folder-title">
          <Icon name="folder" size={16} />
          <span>Файлы для отправки</span>
          <button type="button" className="folder-close" aria-label="Закрыть" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="folder-toolbar">
          <button type="button" disabled={busy} onClick={onUpload}>
            <Icon name="clip" size={14} /> Загрузить
          </button>
          <button type="button" disabled={!sel || busy} onClick={() => sel && onPaste(sel.id)} title="Вставить в открытый чат мессенджера (как Ctrl+V)">
            Вставить в чат
          </button>
          <button type="button" disabled={!sel || busy} onClick={() => sel && onAttach(sel.id)} title="Подставить в окно выбора файла: потом нажмите 📎 в мессенджере">
            Прикрепить через 📎
          </button>
          <button type="button" disabled={!sel || busy} onClick={() => sel && onRemove(sel.id)}>
            Удалить
          </button>
          <span className="folder-path muted">Экран › Файлы</span>
        </div>
        <ul className="folder-grid" role="listbox" aria-label="Файлы">
          {state.files.map((f) => (
            <li key={f.id} role="option" aria-selected={selected === f.id}>
              <button type="button" className={`folder-item${selected === f.id ? ' selected' : ''}`} title={`${f.name}\n${fmtSize(f.size)} · удалится в ${hhmm(f.expiresAt)}${f.attachedAt ? ` · прикреплён в ${hhmm(f.attachedAt)}` : ''}\nДвойной клик — вставить в чат`} onClick={() => setSelected(f.id)} onDoubleClick={() => onPaste(f.id)}>
                <FileThumb id={id} file={f} />
                <span className="folder-name">{f.name}</span>
              </button>
            </li>
          ))}
        </ul>
        <footer className="folder-status muted">
          Объектов: {state.files.length}
          {sel ? ` · выбран «${sel.name}», ${fmtSize(sel.size)}` : ''} · файлы хранятся час
        </footer>
      </div>
    </div>
  );
}

/** Миниатюра: картинка — сама картинка, остальное — значок программы, которая откроет файл. */
function FileThumb({ id, file }: { id: string; file: MessengerScreenFileDto }) {
  const image = file.mime.startsWith('image/') && file.mime !== 'image/svg+xml';
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!image) return;
    let active = true;
    let made: string | null = null;
    void apiBlob(`/messengers/${id}/screen-files/${file.id}/content`).then(
      (b) => {
        if (!active) return;
        made = URL.createObjectURL(b);
        setUrl(made);
      },
      () => undefined,
    );
    return () => {
      active = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [id, file.id, image]);
  if (url) return <img className="folder-thumb" src={url} alt="" />;
  const k = fileKind(file.name, file.mime);
  return (
    <span className={`folder-doc ${k.tone}`} title={`Откроется в: ${k.app}`} aria-hidden="true">
      <i>{k.label}</i>
    </span>
  );
}
